// Runs the built coys-game contract in a local NEAR sandbox: mint, transfer, batch settlement,
// seasons, the upgrade from version 1, and access control. Set COYS_WASM to the wasm path (CI
// builds it with cargo near first).
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

fn wasm() -> anyhow::Result<Vec<u8>> {
    let path = std::env::var("COYS_WASM").unwrap_or_else(|_| "../coys-game/target/near/coys_game.wasm".to_string());
    Ok(std::fs::read(path)?)
}

/// Version 1 (days without seasons), as deployed to coys-game.testnet before seasons existed.
fn wasm_v1() -> anyhow::Result<Vec<u8>> {
    Ok(std::fs::read("res/coys_game_v1.wasm")?)
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
        "hen_mints": [{
            "token_id": format!("hen-{season}-{day}"),
            "owner_id": player.id(),
            "title": "Hen 1",
            "media": "data:image/png;base64,iVBORw0KGgo=",
            "media_hash": "AQID",
            "extra": "{\"body\":\"brown\",\"comb\":\"spiky\"}"
        }],
        "hen_moves": []
    })
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

    let bal = |who: &Account| json!({ "account_id": who.id(), "token_id": "egg-brown" });
    let p: String = contract.view("mt_balance_of").args_json(bal(&player)).await?.json()?;
    let a: String = contract.view("mt_balance_of").args_json(bal(&agent)).await?.json()?;
    assert_eq!((p.as_str(), a.as_str()), ("4", "4"));

    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "hen-s1-1" })).await?.json()?;
    assert_eq!(token["owner_id"], player.id().to_string());
    assert!(token["metadata"]["extra"].as_str().unwrap_or_default().contains("spiky"));

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
async fn version_1_upgrades_in_place_and_its_days_become_the_legacy_season() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let v1 = worker.dev_deploy(&wasm_v1()?).await?;
    v1.call("new").args_json(json!({ "owner_id": v1.id() })).max_gas().transact().await?.into_result()?;
    let (player, agent, mallory) = accounts(&worker).await?;
    for day in 1..=3 {
        // version 1 batches carry no season
        let mut b = batch_in("unused", day, &player, &agent);
        b.as_object_mut().map(|o| o.remove("season"));
        v1.call("settle_day").args_json(json!({ "batch": b })).max_gas().transact().await?.into_result()?;
    }

    let v2 = v1.as_account().deploy(&wasm()?).await?.into_result()?;
    let by_mallory = mallory.call(v2.id(), "migrate").max_gas().transact().await?;
    assert!(by_mallory.is_failure(), "a stranger ran migrate");
    v2.call("migrate").max_gas().transact().await?.into_result()?;

    assert_eq!(last_day(&v2, "legacy").await?, 3);
    let legacy_day2: Value = v2.view("day_record").args_json(json!({ "season": "legacy", "day": 2 })).await?.json()?;
    assert_eq!(legacy_day2["day"], 2);
    let supply: String = v2.view("nft_total_supply").await?.json()?;
    assert_eq!(supply, "3");
    let p: String = v2.view("mt_balance_of").args_json(json!({ "account_id": player.id(), "token_id": "egg-brown" })).await?.json()?;
    assert_eq!(p, "12");

    // the owner is unchanged, a new season starts at day 1, and the legacy season cannot repeat
    v2.call("settle_day").args_json(json!({ "batch": batch_in("s2", 1, &player, &agent) })).max_gas().transact().await?.into_result()?;
    let repeat = v2.call("settle_day").args_json(json!({ "batch": batch_in("legacy", 3, &player, &agent) })).max_gas().transact().await?;
    assert!(repeat.is_failure(), "legacy day 3 settled twice");
    let stranger = mallory.call(v2.id(), "settle_day").args_json(json!({ "batch": batch_in("s3", 1, &mallory, &agent) })).max_gas().transact().await?;
    assert!(stranger.is_failure(), "a non-game account settled after the upgrade");
    Ok(())
}

#[tokio::test]
async fn holders_transfer_their_own_tokens() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    contract.call("settle_day").args_json(json!({ "batch": batch(1, &player, &agent) })).max_gas().transact().await?.into_result()?;

    player
        .call(contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": agent.id(), "token_id": "hen-s1-1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "hen-s1-1" })).await?.json()?;
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
