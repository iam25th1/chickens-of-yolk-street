// Runs the built coys-game contract in a local NEAR sandbox: the Feathers and their 777 cap, the
// compact day settlement (no storage per day), the upgrade from the version 2 code deployed on
// testnet with the release of its day records, the provenance commit, transfers and access
// control. Set COYS_WASM to the wasm path (CI builds it with cargo near first). Measurements (gas,
// storage) print with --nocapture.
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn wasm() -> anyhow::Result<Vec<u8>> {
    let path = std::env::var("COYS_WASM").unwrap_or_else(|_| "../coys-game/target/near/coys_game.wasm".to_string());
    Ok(std::fs::read(path)?)
}

/// Version 2 (seasons, a record per day), exactly as deployed on play.coys-game.testnet (read with view_code).
fn wasm_v2() -> anyhow::Result<Vec<u8>> {
    Ok(std::fs::read("res/coys_game_v2.wasm")?)
}

/// Feather mints in one day's settlement: the server never sends more than this in one batch.
const MINTS_PER_BATCH: u32 = 20;

const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn digest(day: u32) -> String {
    sha256_hex(&format!("settlement {day}"))
}

const GRADES: [&str; 4] = ["fluff", "plume", "quill", "golden-quill"];

fn feather(owner: &Account, grade: &str, season: &str, day: u32) -> Value {
    json!({
        "owner_id": owner.id(),
        "grade": grade,
        "milestone": "full-coop",
        "season": season,
        "day": day,
        // longer than the largest real Feather card still (see the server's feather-image test), so gas and storage are measured true
        "media": format!("data:image/png;base64,{}", "iVBORw0KGgo".repeat(218)),
        "media_hash": "AQID"
    })
}

async fn accounts(worker: &Worker<near_workspaces::network::Sandbox>) -> anyhow::Result<(Account, Account, Account)> {
    let root = worker.root_account()?;
    let player = root.create_subaccount("player").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let agent = root.create_subaccount("bakery").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let mallory = root.create_subaccount("mallory").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    Ok((player, agent, mallory))
}

async fn setup() -> anyhow::Result<(Contract, Account, Account, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    contract.call("new").args_json(json!({ "owner_id": contract.id() })).max_gas().transact().await?.into_result()?;
    let (player, agent, mallory) = accounts(&worker).await?;
    Ok((contract, player, agent, mallory))
}

/// A compact day: digest, the moving farms' nets and the egg moves.
fn batch_in(season: &str, day: u32, player: &Account, agent: &Account) -> Value {
    json!({
        "season": season,
        "day": day,
        "digest": digest(day),
        "supply": 42,
        "multiplier_milli": 1250,
        "farms": [{ "farm": "farm-1", "account": player.id(), "net_milli": "4200" }],
        "eggs": [
            { "kind": "Mint", "from": null, "to": player.id(), "grade": "egg-brown", "amount": "10" },
            { "kind": "Transfer", "from": player.id(), "to": agent.id(), "grade": "egg-brown", "amount": "6" },
            { "kind": "Burn", "from": agent.id(), "to": null, "grade": "egg-brown", "amount": "2" }
        ],
        "feather_mints": []
    })
}

/// A version 2 batch, as the live server sent it before this upgrade (no hen minted).
fn batch_v2(day: u32, player: &Account, agent: &Account) -> Value {
    let mut b = batch_in("s1", day, player, agent);
    if let Some(o) = b.as_object_mut() {
        o.remove("feather_mints");
        o.insert("farms".into(), json!([
            { "farm": "farm-1", "account": player.id(), "net_milli": "4200" },
            { "farm": "farm-2", "account": null, "net_milli": "-1300" },
            { "farm": "farm-3", "account": agent.id(), "net_milli": "0" }
        ]));
        o.insert("hen_mints".into(), json!([]));
        o.insert("hen_moves".into(), json!([]));
    }
    b
}

async fn last_day(contract: &Contract, season: &str) -> anyhow::Result<u32> {
    Ok(contract.view("last_settled_day").args_json(json!({ "season": season })).await?.json()?)
}

async fn settle(contract: &Contract, batch: Value) -> anyhow::Result<Value> {
    Ok(contract.call("settle_day").args_json(json!({ "batch": batch })).max_gas().transact().await?.into_result()?.json()?)
}

#[tokio::test]
async fn the_game_settles_a_day_and_balances_follow() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    let mut b = batch_in("s1", 1, &player, &agent);
    b["feather_mints"] = json!([feather(&player, "quill", "s1", 1)]);
    let done = settle(&contract, b).await?;
    assert_eq!(done["eggs_minted"], "10");
    assert_eq!(done["eggs_burned"], "2");
    assert_eq!(done["feathers"], json!(["001"]));
    let supply: Value = contract.view("feather_supply").await?.json()?;
    assert_eq!(supply, json!({ "minted": 1, "max": 777, "remaining": 776, "provenance": null }));

    let bal = |who: &Account| json!({ "account_id": who.id(), "token_id": "egg-brown" });
    let p: String = contract.view("mt_balance_of").args_json(bal(&player)).await?.json()?;
    let a: String = contract.view("mt_balance_of").args_json(bal(&agent)).await?.json()?;
    assert_eq!((p.as_str(), a.as_str()), ("4", "4"));

    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "001" })).await?.json()?;
    assert_eq!(token["owner_id"], player.id().to_string());
    assert_eq!(token["metadata"]["title"], "Feather #001 of 777: Quill");
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap_or_default())?;
    assert_eq!((extra["grade"].clone(), extra["milestone"].clone(), extra["season"].clone(), extra["day"].clone()), (json!("quill"), json!("full-coop"), json!("s1"), json!(1)));
    let meta: Value = contract.view("nft_metadata").await?.json()?;
    assert_eq!(meta["name"], "Yolk Street Feathers (beta)");
    let head: Value = contract.view("season_head").args_json(json!({ "season": "s1" })).await?.json()?;
    assert_eq!(head["last_digest"], digest(1));
    assert_eq!(head["chain"], sha256_hex(&format!("{ZERO}|s1|1|{}", digest(1))));
    assert_eq!(last_day(&contract, "s1").await?, 1);
    Ok(())
}

#[tokio::test]
async fn a_settled_day_stores_nothing_new() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    settle(&contract, batch_in("s1", 1, &player, &agent)).await?;
    let first = contract.view_account().await?;
    let (mut gas, mut chain) = (0u64, sha256_hex(&format!("{ZERO}|s1|1|{}", digest(1))));
    for day in 2..=31 {
        let out = contract.call("settle_day").args_json(json!({ "batch": batch_in("s1", day, &player, &agent) })).max_gas().transact().await?.into_result()?;
        gas = gas.max(out.total_gas_burnt.as_tgas());
        chain = sha256_hex(&format!("{chain}|s1|{day}|{}", digest(day)));
    }
    let last = contract.view_account().await?;
    println!(
        "compact settlement: 30 days with egg moves, storage {} -> {} bytes ({} bytes a day), most gas in one day {} Tgas",
        first.storage_usage,
        last.storage_usage,
        (last.storage_usage as i64 - first.storage_usage as i64) / 30,
        gas
    );
    assert_eq!(last.storage_usage, first.storage_usage, "a settled day grew the contract's storage");
    let head: Value = contract.view("season_head").args_json(json!({ "season": "s1" })).await?.json()?;
    assert_eq!((head["days_settled"].clone(), head["chain"].clone()), (json!(31), json!(chain)));
    Ok(())
}

#[tokio::test]
async fn a_new_season_starts_at_day_one_after_an_old_season_ended_at_day_three() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    for day in 1..=3 {
        settle(&contract, batch_in("s1", day, &player, &agent)).await?;
    }
    assert_eq!(last_day(&contract, "s1").await?, 3);
    let done = settle(&contract, batch_in("s2", 1, &player, &agent)).await?;
    assert_eq!(done["day"], 1);
    assert_eq!(last_day(&contract, "s2").await?, 1);
    assert_eq!(last_day(&contract, "s1").await?, 3);
    let repeat_old = contract.call("settle_day").args_json(json!({ "batch": batch_in("s1", 3, &player, &agent) })).max_gas().transact().await?;
    assert!(repeat_old.is_failure(), "season s1 settled day 3 twice");
    let repeat_new = contract.call("settle_day").args_json(json!({ "batch": batch_in("s2", 1, &player, &agent) })).max_gas().transact().await?;
    assert!(repeat_new.is_failure(), "season s2 settled day 1 twice");
    Ok(())
}

#[tokio::test]
async fn version_2_upgrades_in_place_and_releases_its_day_records() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let v2 = worker.dev_deploy(&wasm_v2()?).await?;
    v2.call("new").args_json(json!({ "owner_id": v2.id() })).max_gas().transact().await?.into_result()?;
    let (player, agent, mallory) = accounts(&worker).await?;
    v2.call("settle_day").args_json(json!({ "batch": batch_v2(1, &player, &agent) })).max_gas().transact().await?.into_result()?;
    let v2_first = v2.view_account().await?;
    for day in 2..=40 {
        v2.call("settle_day").args_json(json!({ "batch": batch_v2(day, &player, &agent) })).max_gas().transact().await?.into_result()?;
    }
    let before = v2.view_account().await?;
    let v2_per_day = (before.storage_usage - v2_first.storage_usage) / 39;
    println!("version 2: {} bytes a settled day", v2_per_day);
    let mut records = Vec::new();
    for day in 1..=40 {
        let r: Value = v2.view("day_record").args_json(json!({ "season": "s1", "day": day })).await?.json()?;
        records.push(r);
    }

    let v4 = v2.as_account().deploy(&wasm()?).await?.into_result()?;
    let by_mallory = mallory.call(v4.id(), "migrate").max_gas().transact().await?;
    assert!(by_mallory.is_failure(), "a stranger ran migrate");
    let migrated = v4.call("migrate").max_gas().transact().await?.into_result()?;
    let after = v4.view_account().await?;
    println!(
        "upgrade: storage {} -> {} bytes ({:+}), migrate gas {} Tgas",
        before.storage_usage,
        after.storage_usage,
        after.storage_usage as i64 - before.storage_usage as i64,
        migrated.total_gas_burnt.as_tgas()
    );

    // everything from version 2 stays: days, egg balances, the owner
    assert_eq!(last_day(&v4, "s1").await?, 40);
    let day2: Value = v4.view("day_record").args_json(json!({ "season": "s1", "day": 2 })).await?.json()?;
    assert_eq!(day2, records[1]);
    let p: String = v4.view("mt_balance_of").args_json(json!({ "account_id": player.id(), "token_id": "egg-brown" })).await?.json()?;
    assert_eq!(p, "160");
    let meta: Value = v4.view("nft_metadata").await?.json()?;
    assert_eq!(meta["name"], "Yolk Street Feathers (beta)");
    let supply: Value = v4.view("feather_supply").await?.json()?;
    assert_eq!(supply, json!({ "minted": 0, "max": 777, "remaining": 777, "provenance": null }));

    // the live server's version 2 batch still settles, compact; an ordinary hen is refused
    settle(&v4, batch_v2(41, &player, &agent)).await?;
    let mut ordinary = batch_v2(42, &player, &agent);
    ordinary["hen_mints"] = json!([{ "token_id": "hen-1", "owner_id": player.id(), "title": "Hen", "media": "x", "media_hash": "AQID", "extra": "{}" }]);
    let refused = v4.call("settle_day").args_json(json!({ "batch": ordinary })).max_gas().transact().await?;
    assert!(refused.is_failure(), "an ordinary hen was minted after the upgrade");
    let compact_start = v4.view_account().await?;
    for day in 42..=61 {
        settle(&v4, batch_in("s1", day, &player, &agent)).await?;
    }
    let compact_end = v4.view_account().await?;
    println!(
        "after the upgrade: 20 compact days, {} bytes a day (version 2 stored {} bytes a day)",
        (compact_end.storage_usage as i64 - compact_start.storage_usage as i64) / 20,
        v2_per_day
    );
    assert_eq!(compact_end.storage_usage, compact_start.storage_usage);

    // release the 40 version 2 records in two calls; nobody else may
    let stranger = mallory.call(v4.id(), "prune_days").args_json(json!({ "season": "s1", "through": 40, "limit": 40 })).max_gas().transact().await?;
    assert!(stranger.is_failure(), "a stranger released day records");
    let first: Value = v4.call("prune_days").args_json(json!({ "season": "s1", "through": 40, "limit": 25 })).max_gas().transact().await?.into_result()?.json()?;
    assert_eq!(first["pruned_through"], 25);
    let out = v4.call("prune_days").args_json(json!({ "season": "s1", "through": 40, "limit": 25 })).max_gas().transact().await?.into_result()?;
    let head: Value = out.json()?;
    let released = v4.view_account().await?;
    println!(
        "prune: released {} bytes for 40 records ({} a record), {} Tgas for 15",
        compact_end.storage_usage - released.storage_usage,
        (compact_end.storage_usage - released.storage_usage) / 40,
        out.total_gas_burnt.as_tgas()
    );
    assert_eq!(head["pruned_through"], 40);
    let mut archive = ZERO.to_string();
    for (i, r) in records.iter().enumerate() {
        archive = sha256_hex(&format!("{archive}|{}|{}", i + 1, serde_json::to_string(r)?));
    }
    assert_eq!(head["archive"], archive, "the archive hash does not match the records read before the release");
    let gone: Value = v4.view("day_record").args_json(json!({ "season": "s1", "day": 2 })).await?.json()?;
    assert!(gone.is_null());
    assert!(compact_end.storage_usage - released.storage_usage >= 40 * 150, "the records' storage was not released");
    assert_eq!(last_day(&v4, "s1").await?, 61);
    settle(&v4, batch_in("s1", 62, &player, &agent)).await?;
    Ok(())
}

#[tokio::test]
async fn exactly_777_feathers_then_the_778th_is_refused() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    // its own account with room to pay for 777 tokens' storage
    let game = root.create_subaccount("game").initial_balance(NearToken::from_near(60)).transact().await?.into_result()?;
    let contract = game.deploy(&wasm()?).await?.into_result()?;
    contract.call("new").args_json(json!({ "owner_id": contract.id() })).max_gas().transact().await?.into_result()?;
    let (player, agent, mallory) = accounts(&worker).await?;
    let start = contract.view_account().await?;

    // one batch can never pass the cap (tiny images, so the 778 fit in one transaction and reach the contract)
    let mut too_many = batch_in("s1", 1, &player, &agent);
    too_many["feather_mints"] = Value::Array(
        (0..=777)
            .map(|_| {
                let mut f = feather(&player, "fluff", "s1", 1);
                f["media"] = json!("data:image/png;base64,AA==");
                f
            })
            .collect(),
    );
    let over = contract.call("settle_day").args_json(json!({ "batch": too_many })).max_gas().transact().await?;
    assert!(over.is_failure(), "a batch of 778 was accepted");
    let none: Value = contract.view("feather_supply").await?.json()?;
    assert_eq!(none["minted"], 0);

    let (mut minted, mut day, mut max_gas) = (0u32, 1u32, 0u64);
    while minted < 777 {
        let n = (777 - minted).min(MINTS_PER_BATCH);
        let mut b = batch_in("s1", day, &player, &agent);
        b["feather_mints"] = Value::Array((0..n).map(|i| feather(&player, GRADES[((minted + i) % 4) as usize], "s1", day)).collect());
        let out = contract.call("settle_day").args_json(json!({ "batch": b })).max_gas().transact().await?.into_result()?;
        max_gas = max_gas.max(out.total_gas_burnt.as_tgas());
        minted += n;
        day += 1;
    }
    let end = contract.view_account().await?;
    println!(
        "777 Feathers in {} batches of up to {}: most gas in one batch {} Tgas; storage +{} bytes ({} bytes a Feather)",
        day - 1,
        MINTS_PER_BATCH,
        max_gas,
        end.storage_usage - start.storage_usage,
        (end.storage_usage - start.storage_usage) / 777
    );
    let supply: Value = contract.view("feather_supply").await?.json()?;
    assert_eq!(supply, json!({ "minted": 777, "max": 777, "remaining": 0, "provenance": null }));
    let total: String = contract.view("nft_total_supply").await?.json()?;
    assert_eq!(total, "777");
    let last: Value = contract.view("nft_token").args_json(json!({ "token_id": "777" })).await?.json()?;
    assert_eq!(last["metadata"]["title"], "Feather #777 of 777: Fluff");

    let mut b = batch_in("s1", day, &player, &agent);
    b["feather_mints"] = json!([feather(&player, "golden-quill", "s1", day)]);
    let refused = contract.call("settle_day").args_json(json!({ "batch": b })).max_gas().transact().await?;
    assert!(refused.is_failure(), "the 778th Feather was minted");
    assert!(format!("{:?}", refused.into_result().err()).contains("777 is the limit"));
    let total: String = contract.view("nft_total_supply").await?.json()?;
    assert_eq!(total, "777");

    // the day still settles without a mint, and nobody else can mint
    settle(&contract, batch_in("s1", day, &player, &agent)).await?;
    let by_mallory = mallory.call(contract.id(), "settle_day").args_json(json!({ "batch": batch_in("s2", 1, &mallory, &agent) })).max_gas().transact().await?;
    assert!(by_mallory.is_failure());
    Ok(())
}

#[tokio::test]
async fn provenance_is_committed_once_by_the_game() -> anyhow::Result<()> {
    let (contract, player, agent, mallory) = setup().await?;
    let hash = sha256_hex("founders.json");
    let stranger = mallory.call(contract.id(), "commit_provenance").args_json(json!({ "sha256": hash })).max_gas().transact().await?;
    assert!(stranger.is_failure(), "a stranger committed the provenance");
    contract.call("commit_provenance").args_json(json!({ "sha256": hash })).max_gas().transact().await?.into_result()?;
    let again = contract.call("commit_provenance").args_json(json!({ "sha256": sha256_hex("other") })).max_gas().transact().await?;
    assert!(again.is_failure(), "the provenance changed");
    let mut b = batch_in("s1", 1, &player, &agent);
    b["feather_mints"] = json!([feather(&player, "plume", "s1", 1)]);
    settle(&contract, b).await?;
    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "001" })).await?.json()?;
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap_or_default())?;
    assert_eq!(extra["provenance"], hash);
    let supply: Value = contract.view("feather_supply").await?.json()?;
    assert_eq!(supply["provenance"], hash);
    Ok(())
}

#[tokio::test]
async fn holders_transfer_their_own_tokens() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    let mut b = batch_in("s1", 1, &player, &agent);
    b["feather_mints"] = json!([feather(&player, "fluff", "s1", 1)]);
    settle(&contract, b).await?;

    player
        .call(contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": agent.id(), "token_id": "001" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "001" })).await?.json()?;
    assert_eq!(token["owner_id"], agent.id().to_string());

    player
        .call(contract.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": agent.id(), "token_id": "egg-brown", "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let a: String = contract.view("mt_balance_of").args_json(json!({ "account_id": agent.id(), "token_id": "egg-brown" })).await?.json()?;
    assert_eq!(a, "5");
    Ok(())
}

#[tokio::test]
async fn only_the_game_account_can_settle_or_mint() -> anyhow::Result<()> {
    let (contract, player, agent, mallory) = setup().await?;
    let mut b = batch_in("s1", 1, &mallory, &agent);
    b["feather_mints"] = json!([feather(&mallory, "golden-quill", "s1", 1)]);
    let attempt = mallory.call(contract.id(), "settle_day").args_json(json!({ "batch": b })).max_gas().transact().await?;
    assert!(attempt.is_failure(), "a non-game account settled a day");
    let supply: String = contract.view("nft_total_supply").await?.json()?;
    assert_eq!(supply, "0");
    let by_player = player.call(contract.id(), "settle_day").args_json(json!({ "batch": batch_in("s1", 1, &player, &agent) })).max_gas().transact().await?;
    assert!(by_player.is_failure());
    settle(&contract, batch_in("s1", 1, &player, &agent)).await?;
    let again = contract.call("settle_day").args_json(json!({ "batch": batch_in("s1", 1, &player, &agent) })).max_gas().transact().await?;
    assert!(again.is_failure(), "a day settled twice");
    Ok(())
}
