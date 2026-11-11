//! Chickens of Yolk Street game contract, deployed on the game's testnet account.
//!
//! - Hens are NEP-171 NFTs (near-contract-standards), one token per hen; metadata holds the traits
//!   and a small rendered portrait.
//! - Eggs are NEP-245 multi-tokens (near-sdk-contract-tools), one token id per grade.
//! - `settle_day` is the only way the game writes: once per in-game day it mints, moves and burns
//!   egg tokens, mints and moves hens, and records the day's summary and a digest of every farm's
//!   net result. Only the owner (the game account) may call it; holders still use the standard
//!   `nft_*` and `mt_*` methods for their own tokens.

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

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    HenOwners,
    HenMetadata,
    HenEnumeration,
    HenApprovals,
    HenContractMetadata,
    Days,
}

#[derive(PanicOnDefault, Nep245, Owner)]
#[near(contract_state)]
pub struct Contract {
    hens: NonFungibleToken,
    hen_metadata: LazyOption<NFTContractMetadata>,
    days: LookupMap<u32, DayRecord>,
    last_day: u32,
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

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HenMove {
    pub token_id: TokenId,
    pub to: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DayBatch {
    pub day: u32,
    pub supply: u32,
    pub multiplier_milli: u32,
    pub digest: String,
    pub farms: Vec<FarmNet>,
    pub eggs: Vec<EggMove>,
    pub hen_mints: Vec<HenMint>,
    pub hen_moves: Vec<HenMove>,
}

fn grade_ok(grade: &str) -> bool {
    EGG_GRADES.contains(&grade)
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
            hen_metadata: LazyOption::new(
                StorageKey::HenContractMetadata,
                Some(&NFTContractMetadata {
                    spec: NFT_METADATA_SPEC.to_string(),
                    name: "Yolk Street Hens".to_string(),
                    symbol: "HEN".to_string(),
                    icon: None,
                    base_uri: None,
                    reference: None,
                    reference_hash: None,
                }),
            ),
            days: LookupMap::new(StorageKey::Days),
            last_day: 0,
        };
        Owner::init(&mut contract, &owner_id);
        for grade in EGG_GRADES {
            contract.create_token(grade.to_string()).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        }
        contract
    }

    /// The day close. Owner only; days must arrive in order and each lands once.
    pub fn settle_day(&mut self, batch: DayBatch) -> DayRecord {
        Self::require_owner();
        require!(batch.day > self.last_day, "day already settled");

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

        for h in &batch.hen_mints {
            let traits: HashMap<String, String> = near_sdk::serde_json::from_str(&h.extra).unwrap_or_default();
            let description = traits
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect::<Vec<_>>()
                .join(", ");
            // the contract pays storage from its own balance: no deposit asked of the caller
            self.hens.internal_mint_with_refund(
                h.token_id.clone(),
                h.owner_id.clone(),
                Some(TokenMetadata {
                    title: Some(h.title.clone()),
                    description: Some(description),
                    media: Some(h.media.clone()),
                    media_hash: Some(h.media_hash.clone()),
                    copies: Some(1),
                    issued_at: Some(env::block_timestamp_ms().to_string()),
                    expires_at: None,
                    starts_at: None,
                    updated_at: None,
                    extra: Some(h.extra.clone()),
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
            hens_minted: u32::try_from(batch.hen_mints.len()).unwrap_or(u32::MAX),
            hens_moved: u32::try_from(batch.hen_moves.len()).unwrap_or(u32::MAX),
        };
        self.days.insert(batch.day, record.clone());
        self.last_day = batch.day;
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "coys",
                "version": "1.0.0",
                "event": "day_settled",
                "data": [{ "day": record.day, "supply": record.supply, "multiplier_milli": record.multiplier_milli,
                           "digest": record.digest, "farms": batch.farms.len() }],
            })
        ));
        record
    }

    pub fn day_record(&self, day: u32) -> Option<DayRecord> {
        self.days.get(&day).cloned()
    }

    pub fn last_settled_day(&self) -> u32 {
        self.last_day
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

    fn ctx(predecessor: AccountId) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(predecessor)
            .storage_usage(1_000)
            .build());
    }

    fn hen(id: &str, owner: AccountId) -> HenMint {
        HenMint {
            token_id: id.to_string(),
            owner_id: owner,
            title: format!("Hen {id}"),
            media: "data:image/png;base64,AAAA".to_string(),
            media_hash: Base64VecU8(vec![1, 2, 3]),
            extra: r#"{"body":"brown","comb":"spiky"}"#.to_string(),
        }
    }

    fn batch(day: u32) -> DayBatch {
        DayBatch {
            day,
            supply: 12,
            multiplier_milli: 1000,
            digest: "d".repeat(64),
            farms: vec![FarmNet { farm: "f1".into(), account: Some(accounts(1)), net_milli: I64(4200) }],
            eggs: vec![],
            hen_mints: vec![],
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
        b.hen_mints = vec![hen("hen-1", accounts(1)), hen("hen-2", accounts(1))];
        b.hen_moves = vec![HenMove { token_id: "hen-1".into(), to: accounts(3) }];
        let record = c.settle_day(b);
        assert_eq!(record.eggs_minted, U128(10));
        assert_eq!(record.eggs_burned, U128(3));
        assert_eq!(record.hens_minted, 2);
        assert_eq!(c.balance_of("egg-brown", &accounts(1)), 3);
        assert_eq!(c.balance_of("egg-brown", &accounts(2)), 4);
        assert_eq!(c.nft_token("hen-1".into()).map(|t| t.owner_id), Some(accounts(3)));
        assert_eq!(c.nft_supply_for_owner(accounts(1)), U128(1));
        assert_eq!(c.last_settled_day(), 1);
        assert_eq!(c.day_record(1), Some(record));
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
