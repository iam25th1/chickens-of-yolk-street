// Runs the built coys-game contract in a local NEAR sandbox: mint, transfer, batch settlement and
// access control. Set COYS_WASM to the wasm path (CI builds it with cargo near first).
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

fn wasm() -> anyhow::Result<Vec<u8>> {
    let path = std::env::var("COYS_WASM").unwrap_or_else(|_| "../coys-game/target/near/coys_game.wasm".to_string());
    Ok(std::fs::read(path)?)
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
    let root = worker.root_account()?;
    let player = root.create_subaccount("player").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let agent = root.create_subaccount("bakery").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let mallory = root.create_subaccount("mallory").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    Ok((contract, player, agent, mallory))
}

fn batch(day: u32, player: &Account, agent: &Account) -> Value {
    json!({
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
            "token_id": "hen-1",
            "owner_id": player.id(),
            "title": "Hen 1",
            "media": "data:image/png;base64,iVBORw0KGgo=",
            "media_hash": "AQID",
            "extra": "{\"body\":\"brown\",\"comb\":\"spiky\"}"
        }],
        "hen_moves": []
    })
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

    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "hen-1" })).await?.json()?;
    assert_eq!(token["owner_id"], player.id().to_string());
    assert!(token["metadata"]["extra"].as_str().unwrap_or_default().contains("spiky"));

    let last: u32 = contract.view("last_settled_day").await?.json()?;
    assert_eq!(last, 1);
    Ok(())
}

#[tokio::test]
async fn holders_transfer_their_own_tokens() -> anyhow::Result<()> {
    let (contract, player, agent, _) = setup().await?;
    contract.call("settle_day").args_json(json!({ "batch": batch(1, &player, &agent) })).max_gas().transact().await?.into_result()?;

    player
        .call(contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": agent.id(), "token_id": "hen-1" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let token: Value = contract.view("nft_token").args_json(json!({ "token_id": "hen-1" })).await?.json()?;
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
