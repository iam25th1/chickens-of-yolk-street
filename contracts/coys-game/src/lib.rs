//! Chickens of Yolk Street game contract, deployed on the game's testnet account.
//!
//! - The Founding Hens are NEP-171 NFTs (near-contract-standards): at most 777 will ever exist, a
//!   cap this contract enforces. Each token's metadata holds her traits, the milestone she was won
//!   at, the season and day, her number of 777, and a small rendered portrait. Ordinary hens are
//!   not minted (version 2 minted every hen; those older tokens stay as they are).
//! - Eggs are NEP-245 multi-tokens (near-sdk-contract-tools), one token id per grade.
//! - `settle_day` is the only way the game writes: once per in-game day of a season it mints, moves
//!   and burns egg tokens, mints and moves hens, and records the day's summary and a digest of every
//!   farm's net result. Only the owner (the game account) may call it; holders still use the
//!   standard `nft_*` and `mt_*` methods for their own tokens.
//! - Days are keyed by (season, day). A new season (a fresh game database) starts again at day 1;
//!   within a season every day lands once and in order. Version 1 settled days without seasons;
//!   version 2's `migrate` kept those as the season `legacy`. Version 3's `migrate` upgrades a
//!   version 2 contract in place: tokens, balances, days and the owner stay; the founding count
//!   starts at zero.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{Base64VecU8, I64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};
use near_sdk_contract_tools::mt::{Nep245Burn, Nep245Controller, Nep245Mint, Nep245Transfer};
use near_sdk_contract_tools::owner::Owner;
use near_sdk_contract_tools::{Nep245, Owner};

/// Egg token ids, one per grade.
pub const EGG_GRADES: [&str; 4] = ["egg-white", "egg-cream", "egg-brown", "egg-golden"];

/// The season that version 1's days (settled before seasons existed) belong to after `migrate`.
pub const LEGACY_SEASON: &str = "legacy";

/// The Founding Hens: never more than this many, ever.
pub const FOUNDING_MAX: u32 = 777;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    HenOwners,
    HenMetadata,
    HenEnumeration,
    HenApprovals,
    HenContractMetadata,
    Days,
    SeasonDays,
    SeasonLastDay,
}

#[derive(PanicOnDefault, Nep245, Owner)]
#[near(contract_state)]
pub struct Contract {
    hens: NonFungibleToken,
    hen_metadata: LazyOption<NFTContractMetadata>,
    /// Version 1 days, readable as the legacy season.
    legacy_days: LookupMap<u32, DayRecord>,
    /// Settled days, keyed "season:day".
    days: LookupMap<String, DayRecord>,
    /// Last settled day of each season.
    last_days: LookupMap<String, u32>,
    /// Founding Hens minted so far (never more than FOUNDING_MAX).
    founding_minted: u32,
}

/// Version 2 state, read once by `migrate`. Field order matches the version 2 struct.
#[near(serializers = [borsh])]
struct ContractV2 {
    hens: NonFungibleToken,
    hen_metadata: LazyOption<NFTContractMetadata>,
    legacy_days: LookupMap<u32, DayRecord>,
    days: LookupMap<String, DayRecord>,
    last_days: LookupMap<String, u32>,
}

/// How many Founding Hens exist and how many may still be minted.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FoundingSupply {
    pub minted: u32,
    pub max: u32,
    pub remaining: u32,
}

fn founding_metadata() -> NFTContractMetadata {
    NFTContractMetadata {
        spec: NFT_METADATA_SPEC.to_string(),
        name: "Yolk Street Founding Hens".to_string(),
        symbol: "FOUNDING".to_string(),
        icon: None,
        base_uri: None,
        reference: None,
        reference_hash: None,
    }
}

/// What the chain keeps per settled day. Per-farm results travel in the call's arguments and the
/// `day_settled` event; only this summary and their digest are stored.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DayRecord {
    pub day: u32,
    pub supply: u32,
    pub multiplier_milli: u32,
    pub digest: String,
    pub farms: u32,
    pub eggs_minted: U128,
    pub eggs_burned: U128,
    pub egg_transfers: u32,
    pub hens_minted: u32,
    pub hens_moved: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FarmNet {
    pub farm: String,
    pub account: Option<AccountId>,
    pub net_milli: I64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum EggMoveKind {
    Mint,
    Burn,
    Transfer,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EggMove {
    pub kind: EggMoveKind,
    pub from: Option<AccountId>,
    pub to: Option<AccountId>,
    pub grade: String,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HenMint {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub title: String,
    /// Portrait as a data URI (see README: stored with the token so it needs no host).
    pub media: String,
    pub media_hash: Base64VecU8,
    /// Traits as JSON.
    pub extra: String,
}

/// A Founding Hen won at a milestone, minted to her farm's account.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FoundingMint {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    /// Portrait from her stacked trait layers, as a data URI (stored with the token: it needs no host).
    pub media: String,
    pub media_hash: Base64VecU8,
    /// Her traits as JSON (body, eyes, comb, accessory, laying).
    pub traits: String,
    /// The milestone she was won at.
    pub milestone: String,
    pub season: String,
    pub day: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HenMove {
    pub token_id: TokenId,
    pub to: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DayBatch {
    /// Season id: 1 to 32 characters of a-z, 0-9 and '-'.
    pub season: String,
    pub day: u32,
    pub supply: u32,
    pub multiplier_milli: u32,
    pub digest: String,
    pub farms: Vec<FarmNet>,
    pub eggs: Vec<EggMove>,
    /// Ordinary hens are no longer minted: kept so older callers' batches still parse, and refused unless empty.
    #[serde(default)]
    pub hen_mints: Vec<HenMint>,
    #[serde(default)]
    pub founding_mints: Vec<FoundingMint>,
    pub hen_moves: Vec<HenMove>,
}

fn grade_ok(grade: &str) -> bool {
    EGG_GRADES.contains(&grade)
}

fn season_ok(season: &str) -> bool {
    !season.is_empty() && season.len() <= 32 && season.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn day_key(season: &str, day: u32) -> String {
    format!("{season}:{day}")
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let mut contract = Self {
            hens: NonFungibleToken::new(
                StorageKey::HenOwners,
                owner_id.clone(),
                Some(StorageKey::HenMetadata),
                Some(StorageKey::HenEnumeration),
                Some(StorageKey::HenApprovals),
            ),
            hen_metadata: LazyOption::new(StorageKey::HenContractMetadata, Some(&founding_metadata())),
            legacy_days: LookupMap::new(StorageKey::Days),
            days: LookupMap::new(StorageKey::SeasonDays),
            last_days: LookupMap::new(StorageKey::SeasonLastDay),
            founding_minted: 0,
        };
        Owner::init(&mut contract, &owner_id);
        for grade in EGG_GRADES {
            contract.create_token(grade.to_string()).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        }
        contract
    }

    /// Upgrades version 2 state in place after the new code is deployed: tokens, egg balances, days
    /// and the owner are untouched; the collection is renamed the Founding Hens and its count starts
    /// at zero (version 2's ordinary hen tokens stay, outside the 777).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV2 = env::state_read().unwrap_or_else(|| env::panic_str("no version 2 state to migrate"));
        let mut c = Self {
            hens: old.hens,
            hen_metadata: old.hen_metadata,
            legacy_days: old.legacy_days,
            days: old.days,
            last_days: old.last_days,
            founding_minted: 0,
        };
        c.hen_metadata.set(&founding_metadata());
        c
    }

    /// How many Founding Hens exist, of 777, and how many are left.
    pub fn founding_supply(&self) -> FoundingSupply {
        FoundingSupply { minted: self.founding_minted, max: FOUNDING_MAX, remaining: FOUNDING_MAX - self.founding_minted }
    }

    /// The day close. Owner only; within a season days arrive in order and each lands once.
    pub fn settle_day(&mut self, batch: DayBatch) -> DayRecord {
        Self::require_owner();
        require!(season_ok(&batch.season), "season must be 1 to 32 characters of a-z, 0-9 and -");
        let last = self.last_days.get(&batch.season).copied().unwrap_or(0);
        require!(batch.day > last, "day already settled");

        let mut minted: u128 = 0;
        let mut burned: u128 = 0;
        let mut transfers: u32 = 0;
        for m in &batch.eggs {
            require!(grade_ok(&m.grade), "unknown egg grade");
            let amount = m.amount.0;
            if amount == 0 {
                continue;
            }
            match m.kind {
                EggMoveKind::Mint => {
                    let to = m.to.as_ref().unwrap_or_else(|| env::panic_str("mint needs to"));
                    Nep245Controller::mint(self, &Nep245Mint::single(m.grade.as_str(), amount, to.clone()))
                        .unwrap_or_else(|e| env::panic_str(&e.to_string()));
                    minted += amount;
                }
                EggMoveKind::Burn => {
                    let from = m.from.as_ref().unwrap_or_else(|| env::panic_str("burn needs from"));
                    Nep245Controller::burn(self, &Nep245Burn::single(m.grade.as_str(), amount, from.clone()))
                        .unwrap_or_else(|e| env::panic_str(&e.to_string()));
                    burned += amount;
                }
                EggMoveKind::Transfer => {
                    let from = m.from.as_ref().unwrap_or_else(|| env::panic_str("transfer needs from"));
                    let to = m.to.as_ref().unwrap_or_else(|| env::panic_str("transfer needs to"));
                    Nep245Controller::transfer(
                        self,
                        &Nep245Transfer::single(from.clone(), to.clone(), m.grade.as_str(), amount, None::<String>),
                    )
                    .unwrap_or_else(|e| env::panic_str(&e.to_string()));
                    transfers += 1;
                }
            }
        }

        require!(batch.hen_mints.is_empty(), "ordinary hens are not minted: only Founding Hens");
        let room = FOUNDING_MAX - self.founding_minted;
        require!(batch.founding_mints.len() as u64 <= u64::from(room), "the Founding Hens are all minted: 777 is the limit");
        for f in &batch.founding_mints {
            require!(season_ok(&f.season), "season must be 1 to 32 characters of a-z, 0-9 and -");
            require!(!f.milestone.is_empty() && f.milestone.len() <= 32, "milestone must be 1 to 32 characters");
            self.founding_minted += 1;
            let number = self.founding_minted;
            let traits: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&f.traits).unwrap_or(near_sdk::serde_json::Value::Null);
            let words = traits
                .as_object()
                .map(|o| o.iter().map(|(k, v)| format!("{k}: {}", v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            let extra = near_sdk::serde_json::json!({
                "number": number, "of": FOUNDING_MAX, "milestone": f.milestone, "season": f.season, "day": f.day, "traits": traits,
            });
            // the contract pays storage from its own balance: no deposit asked of the caller
            self.hens.internal_mint_with_refund(
                f.token_id.clone(),
                f.owner_id.clone(),
                Some(TokenMetadata {
                    title: Some(format!("Founding Hen #{number} of {FOUNDING_MAX}")),
                    description: Some(format!("A Founding Hen of Yolk Street, won at the milestone {} on day {} of season {}. {words}", f.milestone, f.day, f.season)),
                    media: Some(f.media.clone()),
                    media_hash: Some(f.media_hash.clone()),
                    copies: Some(1),
                    issued_at: Some(env::block_timestamp_ms().to_string()),
                    expires_at: None,
                    starts_at: None,
                    updated_at: None,
                    extra: Some(extra.to_string()),
                    reference: None,
                    reference_hash: None,
                }),
                None,
            );
        }

        for mv in &batch.hen_moves {
            let owner = self
                .hens
                .owner_by_id
                .get(&mv.token_id)
                .unwrap_or_else(|| env::panic_str("unknown hen"));
            if owner != mv.to {
                self.hens.internal_transfer(&owner, &mv.to, &mv.token_id, None, Some("game".to_string()));
            }
        }

        let record = DayRecord {
            day: batch.day,
            supply: batch.supply,
            multiplier_milli: batch.multiplier_milli,
            digest: batch.digest.clone(),
            farms: u32::try_from(batch.farms.len()).unwrap_or(u32::MAX),
            eggs_minted: U128(minted),
            eggs_burned: U128(burned),
            egg_transfers: transfers,
            hens_minted: u32::try_from(batch.founding_mints.len()).unwrap_or(u32::MAX),
            hens_moved: u32::try_from(batch.hen_moves.len()).unwrap_or(u32::MAX),
        };
        self.days.insert(day_key(&batch.season, batch.day), record.clone());
        self.last_days.insert(batch.season.clone(), batch.day);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "coys",
                "version": "3.0.0",
                "event": "day_settled",
                "data": [{ "season": batch.season, "day": record.day, "supply": record.supply,
                           "multiplier_milli": record.multiplier_milli, "digest": record.digest, "farms": batch.farms.len(),
                           "founding_minted": record.hens_minted, "founding_total": self.founding_minted }],
            })
        ));
        record
    }

    pub fn day_record(&self, season: String, day: u32) -> Option<DayRecord> {
        self.days.get(&day_key(&season, day)).cloned().or_else(|| {
            if season == LEGACY_SEASON {
                self.legacy_days.get(&day).cloned()
            } else {
                None
            }
        })
    }

    pub fn last_settled_day(&self, season: String) -> u32 {
        self.last_days.get(&season).copied().unwrap_or(0)
    }

    pub fn egg_grades(&self) -> Vec<String> {
        EGG_GRADES.iter().map(|g| (*g).to_string()).collect()
    }
}

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.hens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.hens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.hens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
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
        self.hen_metadata.get().unwrap_or_else(|| env::panic_str("no metadata"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;
    use near_sdk_contract_tools::mt::Nep245Controller;

    /// Founding mints per test batch (the server sends at most this many in one day's settlement).
    const MINTS_PER_BATCH: u32 = 20;

    fn ctx(predecessor: AccountId) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(predecessor)
            .storage_usage(1_000)
            .build());
    }

    fn founding(id: &str, owner: AccountId) -> FoundingMint {
        FoundingMint {
            token_id: id.to_string(),
            owner_id: owner,
            media: "data:image/png;base64,AAAA".to_string(),
            media_hash: Base64VecU8(vec![1, 2, 3]),
            traits: r#"{"body":"brown","comb":"spiky"}"#.to_string(),
            milestone: "full-coop".to_string(),
            season: "s1".to_string(),
            day: 4,
        }
    }

    fn ordinary(id: &str, owner: AccountId) -> HenMint {
        HenMint {
            token_id: id.to_string(),
            owner_id: owner,
            title: format!("Hen {id}"),
            media: "data:image/png;base64,AAAA".to_string(),
            media_hash: Base64VecU8(vec![1, 2, 3]),
            extra: r#"{"body":"brown"}"#.to_string(),
        }
    }

    fn batch(day: u32) -> DayBatch {
        batch_in("s1", day)
    }

    fn batch_in(season: &str, day: u32) -> DayBatch {
        DayBatch {
            season: season.to_string(),
            day,
            supply: 12,
            multiplier_milli: 1000,
            digest: "d".repeat(64),
            farms: vec![FarmNet { farm: "f1".into(), account: Some(accounts(1)), net_milli: I64(4200) }],
            eggs: vec![],
            hen_mints: vec![],
            founding_mints: vec![],
            hen_moves: vec![],
        }
    }

    #[test]
    fn owner_settles_a_day_with_mints_moves_and_burns() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut b = batch(1);
        b.eggs = vec![
            EggMove { kind: EggMoveKind::Mint, from: None, to: Some(accounts(1)), grade: "egg-brown".into(), amount: U128(10) },
            EggMove { kind: EggMoveKind::Transfer, from: Some(accounts(1)), to: Some(accounts(2)), grade: "egg-brown".into(), amount: U128(4) },
            EggMove { kind: EggMoveKind::Burn, from: Some(accounts(1)), to: None, grade: "egg-brown".into(), amount: U128(3) },
        ];
        b.founding_mints = vec![founding("founding-1", accounts(1)), founding("founding-2", accounts(1))];
        b.hen_moves = vec![HenMove { token_id: "founding-1".into(), to: accounts(3) }];
        let record = c.settle_day(b);
        assert_eq!(record.eggs_minted, U128(10));
        assert_eq!(record.eggs_burned, U128(3));
        assert_eq!(record.hens_minted, 2);
        assert_eq!(c.balance_of("egg-brown", &accounts(1)), 3);
        assert_eq!(c.balance_of("egg-brown", &accounts(2)), 4);
        assert_eq!(c.nft_token("founding-1".into()).map(|t| t.owner_id), Some(accounts(3)));
        let token = c.nft_token("founding-2".into()).and_then(|t| t.metadata).unwrap_or_else(|| panic!("no metadata"));
        assert_eq!(token.title.as_deref(), Some("Founding Hen #2 of 777"));
        let extra: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&token.extra.unwrap_or_default()).unwrap_or_default();
        assert_eq!(extra["milestone"], "full-coop");
        assert_eq!(extra["traits"]["comb"], "spiky");
        assert_eq!(c.founding_supply(), FoundingSupply { minted: 2, max: 777, remaining: 775 });
        assert_eq!(c.nft_supply_for_owner(accounts(1)), U128(1));
        assert_eq!(c.last_settled_day("s1".into()), 1);
        assert_eq!(c.day_record("s1".into(), 1), Some(record));
        assert_eq!(c.day_record("s2".into(), 1), None);
    }

    #[test]
    fn a_new_season_starts_again_at_day_one() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        for day in 1..=3 {
            c.settle_day(batch_in("s1", day));
        }
        let first = c.settle_day(batch_in("s2", 1));
        assert_eq!(first.day, 1);
        assert_eq!(c.last_settled_day("s1".into()), 3);
        assert_eq!(c.last_settled_day("s2".into()), 1);
        assert!(c.day_record("s1".into(), 3).is_some());
        assert!(c.day_record("s2".into(), 1).is_some());
    }

    #[test]
    #[should_panic(expected = "day already settled")]
    fn an_old_season_cannot_repeat_a_day() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        for day in 1..=3 {
            c.settle_day(batch_in("s1", day));
        }
        c.settle_day(batch_in("s2", 1));
        c.settle_day(batch_in("s1", 3));
    }

    #[test]
    #[should_panic(expected = "season must be")]
    fn season_ids_are_checked() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.settle_day(batch_in("Season One!", 1));
    }

    #[test]
    fn migrate_upgrades_version_2_in_place() {
        ctx(accounts(0));
        let mut days = LookupMap::new(StorageKey::SeasonDays);
        let record = DayRecord {
            day: 3,
            supply: 93,
            multiplier_milli: 2500,
            digest: "d".repeat(64),
            farms: 3,
            eggs_minted: U128(26),
            eggs_burned: U128(16),
            egg_transfers: 0,
            hens_minted: 12,
            hens_moved: 0,
        };
        days.insert(day_key("s1", 3), record.clone());
        days.flush();
        let mut last_days = LookupMap::new(StorageKey::SeasonLastDay);
        last_days.insert("s1".to_string(), 3u32);
        last_days.flush();
        let mut hens = NonFungibleToken::new(
            StorageKey::HenOwners,
            accounts(0),
            Some(StorageKey::HenMetadata),
            Some(StorageKey::HenEnumeration),
            Some(StorageKey::HenApprovals),
        );
        hens.internal_mint_with_refund(
            "hen-old".into(),
            accounts(1),
            Some(TokenMetadata { title: Some("Hen old".into()), ..Default::default() }),
            None,
        );
        let v2 = ContractV2 {
            hens,
            hen_metadata: LazyOption::new(StorageKey::HenContractMetadata, None),
            legacy_days: LookupMap::new(StorageKey::Days),
            days,
            last_days,
        };
        env::state_write(&v2);
        let mut c = Contract::migrate();
        Owner::init(&mut c, &accounts(0));
        assert_eq!(c.last_settled_day("s1".into()), 3);
        assert_eq!(c.day_record("s1".into(), 3), Some(record));
        assert_eq!(c.nft_token("hen-old".into()).map(|t| t.owner_id), Some(accounts(1)));
        assert_eq!(c.nft_metadata().name, "Yolk Street Founding Hens");
        assert_eq!(c.founding_supply().minted, 0);
        // the season carries on, now minting Founding Hens
        let mut b = batch_in("s1", 4);
        b.founding_mints = vec![founding("founding-a", accounts(1))];
        assert_eq!(c.settle_day(b).hens_minted, 1);
        assert_eq!(c.founding_supply().remaining, 776);
    }

    #[test]
    fn exactly_777_founding_hens_then_no_more() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut minted = 0u32;
        let mut day = 1;
        while minted < FOUNDING_MAX {
            let mut b = batch_in("s1", day);
            let n = (FOUNDING_MAX - minted).min(MINTS_PER_BATCH);
            ctx(accounts(0)); // a fresh call: gas is per transaction
            b.founding_mints = (0..n).map(|i| founding(&format!("founding-{}", minted + i + 1), accounts(1))).collect();
            c.settle_day(b);
            minted += n;
            day += 1;
        }
        assert_eq!(c.founding_supply(), FoundingSupply { minted: 777, max: 777, remaining: 0 });
        assert_eq!(c.nft_token("founding-777".into()).and_then(|t| t.metadata).and_then(|m| m.title), Some("Founding Hen #777 of 777".to_string()));
        ctx(accounts(0));
        let mut b = batch_in("s1", day);
        b.founding_mints = vec![founding("founding-778", accounts(1))];
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle_day(b)));
        assert!(refused.is_err(), "the 778th Founding Hen was minted");
    }

    #[test]
    #[should_panic(expected = "the Founding Hens are all minted")]
    fn one_batch_cannot_pass_the_cap() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut b = batch_in("s1", 1);
        b.founding_mints = (0..=FOUNDING_MAX).map(|i| founding(&format!("founding-{i}"), accounts(1))).collect();
        c.settle_day(b);
    }

    #[test]
    #[should_panic(expected = "ordinary hens are not minted")]
    fn ordinary_hens_are_refused() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut b = batch_in("s1", 1);
        b.hen_mints = vec![ordinary("hen-1", accounts(1))];
        c.settle_day(b);
    }

    #[test]
    #[should_panic]
    fn others_cannot_settle() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        ctx(accounts(1));
        c.settle_day(batch(1));
    }

    #[test]
    #[should_panic(expected = "day already settled")]
    fn a_day_settles_once() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.settle_day(batch(1));
        c.settle_day(batch(1));
    }

    #[test]
    #[should_panic(expected = "unknown egg grade")]
    fn only_four_grades() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut b = batch(1);
        b.eggs = vec![EggMove { kind: EggMoveKind::Mint, from: None, to: Some(accounts(1)), grade: "egg-purple".into(), amount: U128(1) }];
        c.settle_day(b);
    }
}
