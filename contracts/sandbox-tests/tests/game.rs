// Runs the built coys-game contract in a local NEAR sandbox: Founding Hen mints and their 777 cap,
// transfers, batch settlement, seasons, the upgrade from version 2, and access control. Set
// COYS_WASM to the wasm path (CI builds it with cargo near first). Measurements (gas, storage)
// print with --nocapture.
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

fn wasm() -> anyhow::Result<Vec<u8>> {
    let path = std::env::var("COYS_WASM").unwrap_or_else(|_| "../coys-game/target/near/coys_game.wasm".to_string());
    Ok(std::fs::read(path)?)
}

/// Version 2 (seasons, ordinary hens minted), as deployed to coys-game.testnet before the Founding Hens.
fn wasm_v2() -> anyhow::Result<Vec<u8>> {
    Ok(std::fs::read("res/coys_game_v2.wasm")?)
}

/// Founding mints in one day's settlement: the server never sends more than this in one batch.
const MINTS_PER_BATCH: u32 = 20;

fn founding(id: &str, owner: &Account, season: &str, day: u32) -> Value {
    json!({
        "token_id": id,
        "owner_id": owner.id(),
        "media": format!("data:image/png;base64,{}", "iVBORw0KGgo".repeat(40)),
        "media_hash": "AQID",
        "traits": "{\"body\":\"brown\",\"comb\":\"spiky\",\"eyes\":\"bright\",\"accessory\":\"none\",\"laying\":\"steady\"}",
        "milestone": "full-coop",
        "season": season,
        "day": day
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
    contract
        .call("new")
        .args_json(json!({ "owner_id": contract.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let (player, agent, mallory) = accounts(&worker).await?;
    Ok((contract, player, agent, mallory))
}

fn batch_in(season: &str, day: u32, player: &Account, agent: &Account) -> Value {
    json!({
        "season": season,
        "day": day,
        "supply": 42,
        "multiplier_milli": 1250,
        "digest": "ab".repeat(32),
        "farms": [{ "farm": "farm-1", "account": player.id(), "net_milli": "4200" }],
        "eggs": [
            { "kind": "Mint", "from": null, "to": player.id(), "grade": "egg-brown", "amount": "10" },
            { "kind": "Transfer", "from": player.id(), "to": agent.id(), "grade": "egg-brown", "amount": "6" },
            { "kind": "Burn", "from": agent.id(), "to": null, "grade": "egg-brown", "amount": "2" }
        ],
        "founding_mints": [founding(&format!("founding-{season}-{day}"), player, season, day)],
        "hen_moves": []
    })
}

/// A version 2 batch: an ordinary hen minted every day.
fn batch_v2(day: u32, player: &Account, agent: &Account) -> Value {
    let mut b = batch_in("s1", day, player, agent);
    if let Some(o) = b.as_object_mut() {
        o.remove("founding_mints");
        o.insert(
            "hen_mints".into(),
            json!([{
                "token_id": format!("hen-s1-{day}"),
                "owner_id": player.id(),
                "title": "Hen 1",
                "media": "data:image/png;base64,iVBORw0KGgo=",
                "media_hash": "AQID",
                "extra": "{\"body\":\"brown\"}"
            }]),
        );
    }
    b
}

fn batch(day: u32, player: &Account, agent: &Account) -> Value {
    batch_in("s1", day, player, agent)
}

async fn last_day(contract: &Contract, season: &str) -> anyhow::Result<u32> {
    Ok(contract.view("last_settled_day").args_json(json!({ "season": season })).await?.json()?)
}

#[tokio::test]
async fn the_game_settles_a_day_and_balances_follow() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    let record: Value = contract
        .call("settle_day")
        .args_json(json!({ "batch": batch(1, &player, &agent) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(record["eggs_minted"], "10");
    assert_eq!(record["eggs_burned"], "2");
    assert_eq!(record["hens_minted"], 1);
    let supply: Value = contract.view("founding_supply").await?.json()?;
    assert_eq!(supply, json!({ "minted": 1, "max": 777, "remaining": 776 }));

    let bal = |who: &Account| json!({ "account_id": who.id(), "token_id": "egg-brown" });
    let p: String = contract.view("mt_balance_of").args_json(bal(&player)).await?.json()?;
    let a: String = contract.view("mt_balance_of").args_json(bal(&agent)).await?.json()?;
    assert_eq!((p.as_str(), a.as_str()), ("4", "4"));

    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "founding-s1-1" })).await?.json()?;
    assert_eq!(token["owner_id"], player.id().to_string());
    assert_eq!(token["metadata"]["title"], "Founding Hen #1 of 777");
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap_or_default())?;
    assert_eq!((extra["milestone"].clone(), extra["season"].clone(), extra["day"].clone()), (json!("full-coop"), json!("s1"), json!(1)));
    assert_eq!(extra["traits"]["comb"], "spiky");
    let meta: Value = contract.view("nft_metadata").await?.json()?;
    assert_eq!(meta["name"], "Yolk Street Founding Hens");

    assert_eq!(last_day(&contract, "s1").await?, 1);
    Ok(())
}

#[tokio::test]
async fn a_new_season_starts_at_day_one_after_an_old_season_ended_at_day_three() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    for day in 1..=3 {
        contract.call("settle_day").args_json(json!({ "batch": batch_in("s1", day, &player, &agent) })).max_gas().transact().await?.into_result()?;
    }
    assert_eq!(last_day(&contract, "s1").await?, 3);

    let record: Value = contract
        .call("settle_day")
        .args_json(json!({ "batch": batch_in("s2", 1, &player, &agent) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(record["day"], 1);
    assert_eq!(last_day(&contract, "s2").await?, 1);
    assert_eq!(last_day(&contract, "s1").await?, 3);

    // within a season each day still lands once
    let repeat_old = contract.call("settle_day").args_json(json!({ "batch": batch_in("s1", 3, &player, &agent) })).max_gas().transact().await?;
    assert!(repeat_old.is_failure(), "season s1 settled day 3 twice");
    let repeat_new = contract.call("settle_day").args_json(json!({ "batch": batch_in("s2", 1, &player, &agent) })).max_gas().transact().await?;
    assert!(repeat_new.is_failure(), "season s2 settled day 1 twice");

    let s1_day3: Value = contract.view("day_record").args_json(json!({ "season": "s1", "day": 3 })).await?.json()?;
    let s2_day1: Value = contract.view("day_record").args_json(json!({ "season": "s2", "day": 1 })).await?.json()?;
    assert_eq!((s1_day3["day"].clone(), s2_day1["day"].clone()), (json!(3), json!(1)));
    Ok(())
}

#[tokio::test]
async fn version_2_upgrades_in_place_and_mints_only_founding_hens() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let v2 = worker.dev_deploy(&wasm_v2()?).await?;
    v2.call("new").args_json(json!({ "owner_id": v2.id() })).max_gas().transact().await?.into_result()?;
    let (player, agent, mallory) = accounts(&worker).await?;
    for day in 1..=3 {
        v2.call("settle_day").args_json(json!({ "batch": batch_v2(day, &player, &agent) })).max_gas().transact().await?.into_result()?;
    }
    let before = v2.view_account().await?;

    let v3 = v2.as_account().deploy(&wasm()?).await?.into_result()?;
    let by_mallory = mallory.call(v3.id(), "migrate").max_gas().transact().await?;
    assert!(by_mallory.is_failure(), "a stranger ran migrate");
    let migrated = v3.call("migrate").max_gas().transact().await?.into_result()?;
    let after = v3.view_account().await?;
    println!(
        "upgrade: storage {} -> {} bytes ({:+}), balance {} -> {}, migrate gas {} Tgas",
        before.storage_usage,
        after.storage_usage,
        after.storage_usage as i64 - before.storage_usage as i64,
        before.balance,
        after.balance,
        migrated.total_gas_burnt.as_tgas()
    );

    // everything from version 2 stays: days, the ordinary hens, egg balances, the owner
    assert_eq!(last_day(&v3, "s1").await?, 3);
    let day2: Value = v3.view("day_record").args_json(json!({ "season": "s1", "day": 2 })).await?.json()?;
    assert_eq!((day2["day"].clone(), day2["hens_minted"].clone()), (json!(2), json!(1)));
    let total: String = v3.view("nft_total_supply").await?.json()?;
    assert_eq!(total, "3");
    let old: Value = v3.view("nft_token").args_json(json!({ "token_id": "hen-s1-2" })).await?.json()?;
    assert_eq!(old["owner_id"], player.id().to_string());
    let p: String = v3.view("mt_balance_of").args_json(json!({ "account_id": player.id(), "token_id": "egg-brown" })).await?.json()?;
    assert_eq!(p, "12");
    let meta: Value = v3.view("nft_metadata").await?.json()?;
    assert_eq!(meta["name"], "Yolk Street Founding Hens");
    let supply: Value = v3.view("founding_supply").await?.json()?;
    assert_eq!(supply, json!({ "minted": 0, "max": 777, "remaining": 777 }));

    // ordinary hens are refused now; the season carries on with a Founding Hen
    let ordinary = v3.call("settle_day").args_json(json!({ "batch": batch_v2(4, &player, &agent) })).max_gas().transact().await?;
    assert!(ordinary.is_failure(), "an ordinary hen was minted after the upgrade");
    v3.call("settle_day").args_json(json!({ "batch": batch_in("s1", 4, &player, &agent) })).max_gas().transact().await?.into_result()?;
    let supply: Value = v3.view("founding_supply").await?.json()?;
    assert_eq!(supply, json!({ "minted": 1, "max": 777, "remaining": 776 }));
    let hen: Value = v3.view("nft_token").args_json(json!({ "token_id": "founding-s1-4" })).await?.json()?;
    assert_eq!(hen["metadata"]["title"], "Founding Hen #1 of 777");

    let stranger = mallory.call(v3.id(), "settle_day").args_json(json!({ "batch": batch_in("s3", 1, &mallory, &agent) })).max_gas().transact().await?;
    assert!(stranger.is_failure(), "a non-game account settled after the upgrade");
    Ok(())
}

#[tokio::test]
async fn exactly_777_founding_hens_then_the_778th_is_refused() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    // its own account with room to pay for 777 tokens' storage
    let game = root.create_subaccount("game").initial_balance(NearToken::from_near(60)).transact().await?.into_result()?;
    let contract = game.deploy(&wasm()?).await?.into_result()?;
    contract.call("new").args_json(json!({ "owner_id": contract.id() })).max_gas().transact().await?.into_result()?;
    let (player, agent, mallory) = accounts(&worker).await?;
    let start = contract.view_account().await?;

    // one batch can never pass the cap
    let mut too_many = batch_in("s1", 1, &player, &agent);
    too_many["founding_mints"] = Value::Array((0..=777).map(|i| founding(&format!("f-{i}"), &player, "s1", 1)).collect());
    let over = contract.call("settle_day").args_json(json!({ "batch": too_many })).max_gas().transact().await?;
    assert!(over.is_failure(), "a batch of 778 was accepted");

    let (mut minted, mut day, mut max_gas) = (0u32, 1u32, 0u64);
    while minted < 777 {
        let n = (777 - minted).min(MINTS_PER_BATCH);
        let mut b = batch_in("s1", day, &player, &agent);
        b["founding_mints"] = Value::Array((0..n).map(|i| founding(&format!("founding-{}", minted + i + 1), &player, "s1", day)).collect());
        let out = contract.call("settle_day").args_json(json!({ "batch": b })).max_gas().transact().await?.into_result()?;
        max_gas = max_gas.max(out.total_gas_burnt.as_tgas());
        minted += n;
        day += 1;
    }
    let end = contract.view_account().await?;
    println!(
        "777 founding hens in {} batches of up to {}: most gas in one batch {} Tgas; storage +{} bytes ({} bytes a hen with its day's record)",
        day - 1,
        MINTS_PER_BATCH,
        max_gas,
        end.storage_usage - start.storage_usage,
        (end.storage_usage - start.storage_usage) / 777
    );
    let supply: Value = contract.view("founding_supply").await?.json()?;
    assert_eq!(supply, json!({ "minted": 777, "max": 777, "remaining": 0 }));
    let total: String = contract.view("nft_total_supply").await?.json()?;
    assert_eq!(total, "777");
    let last: Value = contract.view("nft_token").args_json(json!({ "token_id": "founding-777" })).await?.json()?;
    assert_eq!(last["metadata"]["title"], "Founding Hen #777 of 777");

    let mut b = batch_in("s1", day, &player, &agent);
    b["founding_mints"] = json!([founding("founding-778", &player, "s1", day)]);
    let refused = contract.call("settle_day").args_json(json!({ "batch": b })).max_gas().transact().await?;
    assert!(refused.is_failure(), "the 778th Founding Hen was minted");
    assert!(format!("{:?}", refused.into_result().err()).contains("777 is the limit"));
    let none: Value = contract.view("nft_token").args_json(json!({ "token_id": "founding-778" })).await?.json()?;
    assert!(none.is_null());

    // the day still settles without a mint, and nobody else can mint
    let mut quiet = batch_in("s1", day, &player, &agent);
    quiet["founding_mints"] = json!([]);
    contract.call("settle_day").args_json(json!({ "batch": quiet })).max_gas().transact().await?.into_result()?;
    let by_mallory = mallory.call(contract.id(), "settle_day").args_json(json!({ "batch": batch_in("s2", 1, &mallory, &agent) })).max_gas().transact().await?;
    assert!(by_mallory.is_failure());
    Ok(())
}

#[tokio::test]
async fn holders_transfer_their_own_tokens() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    contract.call("settle_day").args_json(json!({ "batch": batch(1, &player, &agent) })).max_gas().transact().await?.into_result()?;

    player
        .call(contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": agent.id(), "token_id": "founding-s1-1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "founding-s1-1" })).await?.json()?;
    assert_eq!(token["owner_id"], agent.id().to_string());

    player
        .call(contract.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": agent.id(), "token_id": "egg-brown", "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let a: String = contract
        .view("mt_balance_of")
        .args_json(json!({ "account_id": agent.id(), "token_id": "egg-brown" }))
        .await?
        .json()?;
    assert_eq!(a, "5");
    Ok(())
}

#[tokio::test]
async fn only_the_game_account_can_settle_or_mint() -> anyhow::Result<()> {
    let (contract, player, agent, mallory) = setup().await?;
    let attempt = mallory
        .call(contract.id(), "settle_day")
        .args_json(json!({ "batch": batch(1, &mallory, &agent) }))
        .max_gas()
        .transact()
        .await?;
    assert!(attempt.is_failure(), "a non-game account settled a day");
    let supply: String = contract.view("nft_total_supply").await?.json()?;
    assert_eq!(supply, "0");

    // a player cannot settle for themselves either, and a day lands only once
    let by_player = player.call(contract.id(), "settle_day").args_json(json!({ "batch": batch(1, &player, &agent) })).max_gas().transact().await?;
    assert!(by_player.is_failure());
    contract.call("settle_day").args_json(json!({ "batch": batch(1, &player, &agent) })).max_gas().transact().await?.into_result()?;
    let again = contract.call("settle_day").args_json(json!({ "batch": batch(1, &player, &agent) })).max_gas().transact().await?;
    assert!(again.is_failure(), "a day settled twice");
    Ok(())
}
