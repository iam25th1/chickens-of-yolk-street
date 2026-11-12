//! Chickens of Yolk Street: the planned mainnet Founding Hens contract. Sandbox-tested only; it is
//! not deployed anywhere (see docs/mainnet-plan.md).
//!
//! At the mainnet launch the testnet Feathers are snapshotted (number, grade, holder), the snapshot
//! is sealed, and the reveal seed is taken from a public event chosen and announced before the
//! snapshot (a future NEAR mainnet block). `reveal` then runs the draw in draw.rs: every Feather
//! number gets a hen rarity (exactly 7 Legendary, 70 Epic, 200 Rare, 500 Common, weighted by grade)
//! and one hen of founders.json, whose SHA-256 (the provenance) was committed on testnet before the
//! first Feather was minted. Each snapshot holder then claims their hens as NEP-171 tokens, paying
//! the tokens' storage.

pub mod draw;

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

use draw::{assign_hens, draw_rarities, Stream, RARITY_COUNTS, TOTAL};

pub const RARITIES: [&str; 4] = ["legendary", "epic", "rare", "common"];
pub const GRADES: [&str; 4] = ["fluff", "plume", "quill", "golden-quill"];

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Owners,
    Metadata,
    Enumeration,
    Approvals,
    ContractMetadata,
    Snapshot,
    Claimed,
    Rarity,
    Hens,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotEntry {
    /// Feather number, 1 to 777.
    pub number: u32,
    pub grade: String,
    pub holder: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Revealed {
    pub number: u32,
    pub rarity: String,
    /// The hen's place in founders.json, 1 to 777.
    pub founder: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub provenance: String,
    pub reveal_source: String,
    pub snapshot: u32,
    pub sealed: bool,
    pub seed: Option<String>,
    pub claimed: u32,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    owner: AccountId,
    hens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    provenance: String,
    reveal_source: String,
    /// Each founders.json hen's rarity (0 Legendary to 3 Common), in file order.
    founder_rarity: Vec<u8>,
    snapshot: LookupMap<u32, SnapshotEntry>,
    snapshot_count: u32,
    sealed: bool,
    seed: Option<String>,
    rarity: LazyOption<Vec<u8>>,
    assigned: LazyOption<Vec<u16>>,
    claimed: LookupSet<u32>,
    claimed_count: u32,
}

fn hex64_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha(b: &[u8]) -> Vec<u8> {
    env::sha256(b)
}

#[near]
impl Contract {
    /// `founder_rarity`: founders.json's rarities in file order (exactly 7/70/200/500), checked
    /// off chain against the provenance hash committed on testnet.
    #[init]
    pub fn new(owner_id: AccountId, provenance: String, reveal_source: String, founder_rarity: Vec<u8>) -> Self {
        require!(hex64_ok(&provenance), "provenance must be 64 lowercase hex characters");
        require!(!reveal_source.is_empty(), "name the public event the reveal seed comes from");
        require!(founder_rarity.len() == TOTAL, "777 founders");
        let mut counts = [0u32; 4];
        for r in &founder_rarity {
            require!(*r < 4, "rarity must be 0 to 3");
            counts[*r as usize] += 1;
        }
        require!(counts == RARITY_COUNTS, "founders must be 7 Legendary, 70 Epic, 200 Rare and 500 Common");
        Self {
            owner: owner_id.clone(),
            hens: NonFungibleToken::new(StorageKey::Owners, owner_id, Some(StorageKey::Metadata), Some(StorageKey::Enumeration), Some(StorageKey::Approvals)),
            metadata: LazyOption::new(
                StorageKey::ContractMetadata,
                Some(&NFTContractMetadata {
                    spec: NFT_METADATA_SPEC.to_string(),
                    name: "Yolk Street Founding Hens".to_string(),
                    symbol: "FOUNDING".to_string(),
                    icon: None,
                    base_uri: None,
                    reference: None,
                    reference_hash: None,
                }),
            ),
            provenance,
            reveal_source,
            founder_rarity,
            snapshot: LookupMap::new(StorageKey::Snapshot),
            snapshot_count: 0,
            sealed: false,
            seed: None,
            rarity: LazyOption::new(StorageKey::Rarity, None),
            assigned: LazyOption::new(StorageKey::Hens, None),
            claimed: LookupSet::new(StorageKey::Claimed),
            claimed_count: 0,
        }
    }

    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    /// Adds Feather holders from the testnet snapshot, in chunks. Owner only, before the seal.
    pub fn add_snapshot(&mut self, entries: Vec<SnapshotEntry>) -> u32 {
        self.require_owner();
        require!(!self.sealed, "the snapshot is sealed");
        for e in entries {
            require!((1..=TOTAL as u32).contains(&e.number), "Feather numbers run 1 to 777");
            require!(GRADES.contains(&e.grade.as_str()), "grade must be fluff, plume, quill or golden-quill");
            if self.snapshot.insert(e.number, e).is_none() {
                self.snapshot_count += 1;
            }
        }
        self.snapshot_count
    }

    /// Closes the snapshot. Owner only.
    pub fn seal_snapshot(&mut self) -> u32 {
        self.require_owner();
        self.sealed = true;
        self.snapshot_count
    }

    /// Runs the draw once, from the seed taken from the announced public event. Owner only, after the seal.
    pub fn reveal(&mut self, seed: String) -> Status {
        self.require_owner();
        require!(self.sealed, "seal the snapshot first");
        require!(self.seed.is_none(), "already revealed");
        require!(!seed.is_empty(), "seed");
        let grades: Vec<u8> = (1..=TOTAL as u32)
            .map(|n| self.snapshot.get(&n).map(|e| GRADES.iter().position(|g| *g == e.grade).unwrap_or(0) as u8).unwrap_or(0))
            .collect();
        let mut stream = Stream::new(&seed, sha);
        let rarity = draw_rarities(&mut stream, &grades);
        let assigned = assign_hens(&mut stream, &rarity, &self.founder_rarity);
        self.rarity.set(&rarity);
        self.assigned.set(&assigned);
        self.seed = Some(seed);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({ "standard": "coys-founding", "version": "1.0.0", "event": "reveal", "data": [{ "seed": self.seed, "source": self.reveal_source }] })
        ));
        self.status()
    }

    /// The snapshot holder of a Feather claims its Founding Hen, paying her storage. Once per number.
    #[payable]
    pub fn claim(&mut self, number: u32) -> Token {
        let rarity = self.rarity.get().unwrap_or_else(|| env::panic_str("not revealed yet"));
        let assigned = self.assigned.get().unwrap_or_else(|| env::panic_str("not revealed yet"));
        let entry = self.snapshot.get(&number).cloned().unwrap_or_else(|| env::panic_str("no Feather with that number in the snapshot"));
        require!(entry.holder == env::predecessor_account_id(), "only the snapshot holder may claim");
        require!(self.claimed.insert(number), "already claimed");
        self.claimed_count += 1;
        let idx = (number - 1) as usize;
        let founder = u32::from(assigned[idx]) + 1;
        let r = RARITIES[rarity[idx] as usize];
        let token_id = format!("hen-{founder:03}");
        self.hens.internal_mint(
            token_id,
            entry.holder.clone(),
            Some(TokenMetadata {
                title: Some(format!("Founding Hen {founder:03} of 777 ({r})")),
                description: Some(format!("Hatched from Feather #{number:03} ({}).", entry.grade)),
                extra: Some(near_sdk::serde_json::json!({ "founder": founder, "rarity": r, "feather": number, "grade": entry.grade, "provenance": self.provenance }).to_string()),
                copies: Some(1),
                ..Default::default()
            }),
        )
    }

    pub fn reveal_of(&self, number: u32) -> Option<Revealed> {
        let rarity = self.rarity.get()?;
        let assigned = self.assigned.get()?;
        let idx = number.checked_sub(1)? as usize;
        Some(Revealed { number, rarity: RARITIES[*rarity.get(idx)? as usize].to_string(), founder: u32::from(*assigned.get(idx)?) + 1 })
    }

    /// Revealed numbers from `from` (1 to 777), at most `limit` of them.
    pub fn reveals(&self, from: u32, limit: u32) -> Vec<Revealed> {
        (from.max(1)..from.max(1).saturating_add(limit).min(TOTAL as u32 + 1)).filter_map(|n| self.reveal_of(n)).collect()
    }

    pub fn snapshot_of(&self, number: u32) -> Option<SnapshotEntry> {
        self.snapshot.get(&number).cloned()
    }

    /// How many numbers drew each rarity (Legendary, Epic, Rare, Common).
    pub fn rarity_counts(&self) -> Vec<u32> {
        let mut c = vec![0u32; 4];
        for r in self.rarity.get().unwrap_or_default() {
            c[r as usize] += 1;
        }
        c
    }

    pub fn status(&self) -> Status {
        Status {
            provenance: self.provenance.clone(),
            reveal_source: self.reveal_source.clone(),
            snapshot: self.snapshot_count,
            sealed: self.sealed,
            seed: self.seed.clone(),
            claimed: self.claimed_count,
        }
    }
}

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.hens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        self.hens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.hens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        self.hens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.hens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.hens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.hens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.hens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap_or_else(|| env::panic_str("no metadata"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn ctx(predecessor: AccountId, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn founders() -> Vec<u8> {
        let mut f = Vec::new();
        for (r, n) in RARITY_COUNTS.iter().enumerate() {
            f.extend(std::iter::repeat(r as u8).take(*n as usize));
        }
        f
    }

    fn contract() -> Contract {
        ctx(accounts(0), 0);
        Contract::new(accounts(0), "a".repeat(64), "near-mainnet block 150000000".into(), founders())
    }

    #[test]
    fn snapshot_reveal_claim() {
        let mut c = contract();
        let entries: Vec<SnapshotEntry> = (1..=600).map(|n| SnapshotEntry { number: n, grade: GRADES[(n % 4) as usize].into(), holder: accounts((n % 3 + 1) as usize) }).collect();
        for chunk in entries.chunks(100) {
            c.add_snapshot(chunk.to_vec());
        }
        assert_eq!(c.seal_snapshot(), 600);
        let s = c.reveal("near-mainnet:150000000:hash".into());
        assert_eq!(s.seed.as_deref(), Some("near-mainnet:150000000:hash"));
        assert_eq!(c.rarity_counts(), vec![7, 70, 200, 500]);
        let r = c.reveal_of(5).unwrap_or_else(|| panic!("revealed"));
        let holder = c.snapshot_of(5).map(|e| e.holder).unwrap_or_else(|| accounts(0));
        ctx(holder.clone(), 10u128.pow(22));
        let token = c.claim(5);
        assert_eq!(token.owner_id, holder);
        assert_eq!(token.token_id, format!("hen-{:03}", r.founder));
    }

    #[test]
    #[should_panic(expected = "only the snapshot holder may claim")]
    fn strangers_cannot_claim() {
        let mut c = contract();
        c.add_snapshot(vec![SnapshotEntry { number: 1, grade: "quill".into(), holder: accounts(1) }]);
        c.seal_snapshot();
        c.reveal("s".into());
        ctx(accounts(2), 10u128.pow(22));
        c.claim(1);
    }

    #[test]
    #[should_panic(expected = "the snapshot is sealed")]
    fn a_sealed_snapshot_is_final() {
        let mut c = contract();
        c.seal_snapshot();
        c.add_snapshot(vec![SnapshotEntry { number: 1, grade: "quill".into(), holder: accounts(1) }]);
    }

    #[test]
    #[should_panic(expected = "already revealed")]
    fn the_reveal_runs_once() {
        let mut c = contract();
        c.seal_snapshot();
        c.reveal("one".into());
        c.reveal("two".into());
    }

    #[test]
    #[should_panic(expected = "founders must be")]
    fn founders_must_split_7_70_200_500() {
        ctx(accounts(0), 0);
        let mut f = founders();
        f[0] = 3;
        Contract::new(accounts(0), "a".repeat(64), "x".into(), f);
    }
}
