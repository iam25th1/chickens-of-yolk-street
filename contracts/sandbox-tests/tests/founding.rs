// The planned mainnet Founding Hens contract (contracts/founding-hens) in a local sandbox: a full
// 777-Feather snapshot, the seal, the reveal from an announced public event's seed, exactly
// 7/70/200/500, the same draw from the same seed on a second deployment, and claims. It is never
// deployed to a real network. Set FOUNDING_WASM to the wasm path.
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

fn wasm() -> anyhow::Result<Vec<u8>> {
    let path = std::env::var("FOUNDING_WASM").unwrap_or_else(|_| "../founding-hens/target/near/founding_hens.wasm".to_string());
    Ok(std::fs::read(path)?)
}

const GRADES: [&str; 4] = ["fluff", "plume", "quill", "golden-quill"];
const SEED: &str = "near-mainnet:150000000:5ZsfHz8fL3uR9ybZ1vUhyQ2pWw6Xk7cB3JdEs4aNtq1F";

fn founders() -> Vec<u8> {
    let mut f = Vec::new();
    for (r, n) in [7usize, 70, 200, 500].iter().enumerate() {
        f.extend(std::iter::repeat(r as u8).take(*n));
    }
    f
}

async fn deploy(worker: &Worker<near_workspaces::network::Sandbox>, holders: &[Account]) -> anyhow::Result<Contract> {
    let contract = worker.dev_deploy(&wasm()?).await?;
    contract
        .call("new")
        .args_json(json!({ "owner_id": contract.id(), "provenance": "ab".repeat(32), "reveal_source": "NEAR mainnet block 150000000", "founder_rarity": founders() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    // every number minted, grades in a fixed mix: a Golden Quill in every 10, a Quill in every 5
    let entries: Vec<Value> = (1..=777u32)
        .map(|n| {
            let g = if n % 10 == 0 { 3 } else if n % 5 == 0 { 2 } else if n % 2 == 0 { 1 } else { 0 };
            json!({ "number": n, "grade": GRADES[g], "holder": holders[(n as usize) % holders.len()].id() })
        })
        .collect();
    for chunk in entries.chunks(150) {
        contract.call("add_snapshot").args_json(json!({ "entries": chunk })).max_gas().transact().await?.into_result()?;
    }
    contract.call("seal_snapshot").max_gas().transact().await?.into_result()?;
    Ok(contract)
}

async fn all_reveals(contract: &Contract) -> anyhow::Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut from = 1;
    while from <= 777 {
        let page: Vec<Value> = contract.view("reveals").args_json(json!({ "from": from, "limit": 200 })).await?.json()?;
        out.extend(page);
        from += 200;
    }
    Ok(out)
}

#[tokio::test]
async fn the_reveal_yields_exactly_7_70_200_500_and_is_reproducible() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mut holders = Vec::new();
    for name in ["ada", "bo", "cy"] {
        holders.push(root.create_subaccount(name).initial_balance(NearToken::from_near(5)).transact().await?.into_result()?);
    }
    let a = deploy(&worker, &holders).await?;
    let b = deploy(&worker, &holders).await?;

    let early = holders[0].call(a.id(), "claim").args_json(json!({ "number": 3 })).deposit(NearToken::from_millinear(20)).max_gas().transact().await?;
    assert!(early.is_failure(), "a hen was claimed before the reveal");
    let stranger = holders[0].call(a.id(), "reveal").args_json(json!({ "seed": SEED })).max_gas().transact().await?;
    assert!(stranger.is_failure(), "a holder ran the reveal");

    let out = a.call("reveal").args_json(json!({ "seed": SEED })).max_gas().transact().await?.into_result()?;
    println!("reveal of 777 Feathers: {} Tgas", out.total_gas_burnt.as_tgas());
    b.call("reveal").args_json(json!({ "seed": SEED })).max_gas().transact().await?.into_result()?;
    let again = a.call("reveal").args_json(json!({ "seed": "another" })).max_gas().transact().await?;
    assert!(again.is_failure(), "the reveal ran twice");

    let counts: Vec<u32> = a.view("rarity_counts").await?.json()?;
    assert_eq!(counts, vec![7, 70, 200, 500]);
    let ra = all_reveals(&a).await?;
    let rb = all_reveals(&b).await?;
    assert_eq!(ra.len(), 777);
    assert_eq!(ra, rb, "the same seed and snapshot gave a different draw");
    // every founders.json hen goes to exactly one Feather
    let mut founders: Vec<u64> = ra.iter().map(|r| r["founder"].as_u64().unwrap_or(0)).collect();
    founders.sort_unstable();
    assert_eq!(founders, (1..=777).collect::<Vec<u64>>());
    // grades tilt the odds: Golden Quills (one in ten) hold more than their share of the Legendaries
    let golden_legendary = ra.iter().filter(|r| r["rarity"] == "legendary" && r["number"].as_u64().unwrap_or(1) % 10 == 0).count();
    println!("legendary hens drawn by Golden Quills (77 of 777 Feathers): {golden_legendary} of 7");

    // the snapshot holder claims; nobody else can, and only once
    let n = 10u32;
    let holder = &holders[(n as usize) % holders.len()];
    let other = &holders[(n as usize + 1) % holders.len()];
    let refused = other.call(a.id(), "claim").args_json(json!({ "number": n })).deposit(NearToken::from_millinear(20)).max_gas().transact().await?;
    assert!(refused.is_failure(), "a stranger claimed a hen");
    let token: Value = holder.call(a.id(), "claim").args_json(json!({ "number": n })).deposit(NearToken::from_millinear(20)).max_gas().transact().await?.into_result()?.json()?;
    let mine = &ra[(n - 1) as usize];
    assert_eq!(token["token_id"], format!("hen-{:03}", mine["founder"].as_u64().unwrap_or(0)));
    assert_eq!(token["owner_id"], holder.id().to_string());
    let twice = holder.call(a.id(), "claim").args_json(json!({ "number": n })).deposit(NearToken::from_millinear(20)).max_gas().transact().await?;
    assert!(twice.is_failure(), "a hen was claimed twice");
    Ok(())
}
