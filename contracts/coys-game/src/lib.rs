//! Chickens of Yolk Street game contract, deployed on the game's testnet account.
//!
//! - The Feathers (beta) are NEP-171 NFTs (near-contract-standards): at most 777 will ever exist, a
//!   cap this contract enforces. A Feather is a claim ticket for one of the 777 Founding Hens,
//!   planned to be revealed and minted as hens at the mainnet launch. Each token stores its number,
//!   its grade (fluff, plume, quill or golden-quill), the milestone it was won at, the season and
//!   day, and a still image of its Feather card. Ordinary hens are never minted.
//! - Eggs are NEP-245 multi-tokens (near-sdk-contract-tools), one token id per grade.
//! - `settle_day` is the only way the game writes: once per in-game day of a season it mints, moves
//!   and burns egg tokens and mints the day's Feathers. It stores only a fixed-size head per season
//!   (the last day, its settlement digest and a running hash chain), so a settled day adds no
//!   storage. The full settlement stays in the game's database; its SHA-256 is the day's digest.
//! - Version 2 kept a record per settled day. `prune_days` releases those records in order, folding
//!   each into the season's archive hash, so the history stays verifiable from the database.
//! - `commit_provenance` stores, once, the SHA-256 of founders.json: the 777 Founding Hens the
//!   Feathers are planned to hatch into, generated before the first Feather is minted.
//! - Version 5: only the live season (`set_live_season`) mints Feathers against the 777; a test
//!   season's Feathers can be burnt (`burn_test_feathers`) and their numbers return to the supply,
//!   reused smallest first. A day whose settlement failed is caught up later by its digest
//!   (`settle_late_days`), folded into the season's late record, so no day stays unrecorded.
//! - Only the owner (the game account) may write; holders use the standard `nft_*` and `mt_*`
//!   methods for their own tokens. `migrate` upgrades a version 2 contract in place.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::{NftBurn, NftMint};
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

/// The season that version 1's days (settled before seasons existed) belong to.
pub const LEGACY_SEASON: &str = "legacy";

/// The Feathers: never more than this many, ever.
pub const FEATHER_MAX: u32 = 777;

/// Feather grades, lowest first. The grade sets a Feather's odds of a high-rarity hen at the reveal.
pub const FEATHER_GRADES: [&str; 4] = ["fluff", "plume", "quill", "golden-quill"];

/// A hash chain's starting value.
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

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
    SeasonHeads,
    LateDays,
}

#[derive(PanicOnDefault, Nep245, Owner)]
#[near(contract_state)]
pub struct Contract {
    /// The Feathers. Version 2 kept its hen tokens here; none were left when it was upgraded.
    feathers: NonFungibleToken,
    feather_metadata: LazyOption<NFTContractMetadata>,
    /// Version 1 days (the legacy season), until released by `prune_days`.
    legacy_days: LookupMap<u32, DayRecord>,
    /// Version 2 days, keyed "season:day", until released by `prune_days`.
    days: LookupMap<String, DayRecord>,
    /// Version 2's last settled day of each season; a season's head takes over from it.
    last_days: LookupMap<String, u32>,
    /// One fixed-size head per season: everything a settled day keeps on chain.
    heads: LookupMap<String, SeasonHead>,
    /// Feathers minted so far (never more than FEATHER_MAX).
    feathers_minted: u32,
    /// SHA-256 (hex) of founders.json, committed once.
    provenance: Option<String>,
    /// Feather numbers returned to the supply by a burn, reused smallest first.
    returned: Vec<u32>,
    /// The only season whose day closes mint Feathers against the 777.
    live_season: Option<String>,
    /// Per season: days settled late (after a failed day close), by digest.
    late: LookupMap<String, LateRecord>,
}

/// Version 4 state, read once by `migrate`. Field order matches the version 4 struct.
#[near(serializers = [borsh])]
struct ContractV4 {
    feathers: NonFungibleToken,
    feather_metadata: LazyOption<NFTContractMetadata>,
    legacy_days: LookupMap<u32, DayRecord>,
    days: LookupMap<String, DayRecord>,
    last_days: LookupMap<String, u32>,
    heads: LookupMap<String, SeasonHead>,
    feathers_minted: u32,
    provenance: Option<String>,
}

/// Days of a season settled late, and sha256("{hash}|{season}|{day}|{digest}") over them in order of arrival.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct LateRecord {
    pub days: Vec<u32>,
    pub hash: String,
}

/// A day settled late: its number and the SHA-256 of its full settlement.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LateDay {
    pub day: u32,
    pub digest: String,
}

/// Version 2 state, read once by `migrate_v2`. Field order matches the version 2 struct.
#[near(serializers = [borsh])]
struct ContractV2 {
    hens: NonFungibleToken,
    hen_metadata: LazyOption<NFTContractMetadata>,
    legacy_days: LookupMap<u32, DayRecord>,
    days: LookupMap<String, DayRecord>,
    last_days: LookupMap<String, u32>,
}

/// A version 2 day record (no longer written; read and released by `prune_days`).
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

/// What a season keeps on chain. Its size never changes, so settling a day stores nothing new.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SeasonHead {
    /// The last settled day.
    pub last_day: u32,
    /// That day's settlement digest: SHA-256 (hex) of its full record in the game's database.
    pub last_digest: String,
    /// sha256("{chain}|{season}|{day}|{digest}") over every day settled since version 4, in order.
    pub chain: String,
    /// Days settled since version 4.
    pub days_settled: u32,
    /// The last day version 2 recorded for this season (0 for a season that began on version 4).
    pub v2_through: u32,
    /// Version 2 records released so far: every day up to this one.
    pub pruned_through: u32,
    /// sha256("{archive}|{day}|{record as JSON}") over every released record, in order.
    pub archive: String,
}

/// How many Feathers exist, of 777, the committed provenance hash, and the season that mints.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FeatherSupply {
    pub minted: u32,
    pub max: u32,
    pub remaining: u32,
    pub provenance: Option<String>,
    pub live_season: Option<String>,
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

/// A Feather to mint: the contract numbers it (#001 to #777, in mint order).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FeatherMint {
    pub owner_id: AccountId,
    /// fluff, plume, quill or golden-quill.
    pub grade: String,
    /// The milestone its ticket was won at.
    pub milestone: String,
    pub season: String,
    pub day: u32,
    /// A still image of its Feather card, as a data URI (stored with the token: it needs no host).
    pub media: String,
    pub media_hash: Base64VecU8,
}

/// An ordinary hen, as older callers sent them. Never minted: a batch carrying one is refused.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HenMint {
    pub token_id: TokenId,
    pub owner_id: AccountId,
}

/// A hen token move, as older callers sent them. Refused: no hen tokens exist.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HenMove {
    pub token_id: TokenId,
    pub to: AccountId,
}

/// One day's settlement. Only the head it updates is stored; the rest travels in the call's
/// arguments and the `day_settled` event.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DayBatch {
    /// Season id: 1 to 32 characters of a-z, 0-9 and '-'.
    pub season: String,
    pub day: u32,
    /// SHA-256 (hex) of the day's full settlement as the game's database keeps it.
    pub digest: String,
    #[serde(default)]
    pub supply: u32,
    #[serde(default)]
    pub multiplier_milli: u32,
    /// Net totals for the farms whose tokens move today.
    #[serde(default)]
    pub farms: Vec<FarmNet>,
    #[serde(default)]
    pub eggs: Vec<EggMove>,
    #[serde(default)]
    pub feather_mints: Vec<FeatherMint>,
    /// Older callers: must be empty.
    #[serde(default)]
    pub hen_mints: Vec<HenMint>,
    #[serde(default)]
    pub hen_moves: Vec<HenMove>,
}

/// What `settle_day` returns (not stored).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DaySettled {
    pub season: String,
    pub day: u32,
    pub chain: String,
    /// Token ids of the Feathers minted, in order.
    pub feathers: Vec<TokenId>,
    pub eggs_minted: U128,
    pub eggs_burned: U128,
    pub egg_transfers: u32,
}

fn feather_metadata() -> NFTContractMetadata {
    NFTContractMetadata {
        spec: NFT_METADATA_SPEC.to_string(),
        name: "Yolk Street Feathers (beta)".to_string(),
        symbol: "FEATHER".to_string(),
        icon: None,
        base_uri: None,
        reference: None,
        reference_hash: None,
    }
}

fn grade_ok(grade: &str) -> bool {
    EGG_GRADES.contains(&grade)
}

fn season_ok(season: &str) -> bool {
    !season.is_empty() && season.len() <= 32 && season.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn hex64_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn day_key(season: &str, day: u32) -> String {
    format!("{season}:{day}")
}

fn sha256_hex(text: &str) -> String {
    env::sha256(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Feather token ids: the number, three digits.
pub fn feather_token_id(number: u32) -> TokenId {
    format!("{number:03}")
}

fn grade_label(grade: &str) -> &'static str {
    match grade {
        "fluff" => "Fluff",
        "plume" => "Plume",
        "quill" => "Quill",
        _ => "Golden Quill",
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let mut contract = Self {
            feathers: NonFungibleToken::new(
                StorageKey::HenOwners,
                owner_id.clone(),
                Some(StorageKey::HenMetadata),
                Some(StorageKey::HenEnumeration),
                Some(StorageKey::HenApprovals),
            ),
            feather_metadata: LazyOption::new(StorageKey::HenContractMetadata, Some(&feather_metadata())),
            legacy_days: LookupMap::new(StorageKey::Days),
            days: LookupMap::new(StorageKey::SeasonDays),
            last_days: LookupMap::new(StorageKey::SeasonLastDay),
            heads: LookupMap::new(StorageKey::SeasonHeads),
            feathers_minted: 0,
            provenance: None,
            returned: Vec::new(),
            live_season: None,
            late: LookupMap::new(StorageKey::LateDays),
        };
        Owner::init(&mut contract, &owner_id);
        for grade in EGG_GRADES {
            contract.create_token(grade.to_string()).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        }
        contract
    }

    /// Upgrades version 4 state in place after the new code is deployed: every token, balance,
    /// head and the provenance stay; no Feather number has been returned yet and no season mints
    /// until `set_live_season`.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV4 = env::state_read().unwrap_or_else(|| env::panic_str("no version 4 state to migrate"));
        Self {
            feathers: old.feathers,
            feather_metadata: old.feather_metadata,
            legacy_days: old.legacy_days,
            days: old.days,
            last_days: old.last_days,
            heads: old.heads,
            feathers_minted: old.feathers_minted,
            provenance: old.provenance,
            returned: Vec::new(),
            live_season: None,
            late: LookupMap::new(StorageKey::LateDays),
        }
    }

    /// Upgrades version 2 state in place (a contract that skipped version 4): egg balances, days and
    /// the owner stay; the token collection becomes the Feathers (version 2 left it empty).
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v2() -> Self {
        let old: ContractV2 = env::state_read().unwrap_or_else(|| env::panic_str("no version 2 state to migrate"));
        let mut c = Self {
            feathers: old.hens,
            feather_metadata: old.hen_metadata,
            legacy_days: old.legacy_days,
            days: old.days,
            last_days: old.last_days,
            heads: LookupMap::new(StorageKey::SeasonHeads),
            feathers_minted: 0,
            provenance: None,
            returned: Vec::new(),
            live_season: None,
            late: LookupMap::new(StorageKey::LateDays),
        };
        require!(c.feathers.owner_by_id.len() == 0, "version 2 still holds hen tokens");
        c.feather_metadata.set(&feather_metadata());
        c
    }

    /// The season whose day closes mint Feathers against the 777 (every other season's are refused). Owner only.
    pub fn set_live_season(&mut self, season: String) -> String {
        Self::require_owner();
        require!(season_ok(&season), "season must be 1 to 32 characters of a-z, 0-9 and -");
        self.live_season = Some(season.clone());
        season
    }

    /// Burns Feathers a test season minted and returns their numbers to the supply (reused, smallest
    /// first). Owner only; a Feather of the live season can never be burnt here.
    pub fn burn_test_feathers(&mut self, token_ids: Vec<TokenId>) -> FeatherSupply {
        Self::require_owner();
        let live = self.live_season.clone().unwrap_or_else(|| env::panic_str("set the live season first"));
        for id in &token_ids {
            let owner = self.feathers.owner_by_id.get(id).unwrap_or_else(|| env::panic_str("no such Feather"));
            let meta = self.feathers.token_metadata_by_id.as_ref().and_then(|m| m.get(id)).unwrap_or_else(|| env::panic_str("no metadata"));
            let extra: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&meta.extra.unwrap_or_default()).unwrap_or_default();
            let season = extra["season"].as_str().unwrap_or_default().to_string();
            let number = extra["number"].as_u64().unwrap_or(0) as u32;
            require!(number >= 1 && number <= FEATHER_MAX, "not a Feather");
            require!(season != live, "a Feather of the live season is never burnt");
            self.feathers.owner_by_id.remove(id);
            if let Some(m) = self.feathers.token_metadata_by_id.as_mut() {
                m.remove(id);
            }
            if let Some(per) = self.feathers.tokens_per_owner.as_mut() {
                if let Some(mut set) = per.get(&owner) {
                    set.remove(id);
                    if set.is_empty() {
                        per.remove(&owner);
                    } else {
                        per.insert(&owner, &set);
                    }
                }
            }
            if let Some(a) = self.feathers.approvals_by_id.as_mut() {
                a.remove(id);
            }
            if !self.returned.contains(&number) {
                self.returned.push(number);
            }
            NftBurn { owner_id: &owner, token_ids: &[id.as_str()], authorized_id: None, memo: Some(&season) }.emit();
        }
        self.returned.sort_unstable();
        self.feather_supply()
    }

    /// Records days of a season whose day close failed, after the season moved on: each by the
    /// SHA-256 of its full settlement, folded into the season's late record (no tokens move: the
    /// next settled day already brought every balance up to date). Owner only; each day once.
    pub fn settle_late_days(&mut self, season: String, days: Vec<LateDay>) -> LateRecord {
        Self::require_owner();
        let head = self.heads.get(&season).cloned().unwrap_or_else(|| env::panic_str("no such season"));
        let mut rec = self.late.get(&season).cloned().unwrap_or_else(|| LateRecord { days: Vec::new(), hash: ZERO_HASH.to_string() });
        for d in &days {
            require!(hex64_ok(&d.digest), "digest must be the settlement's SHA-256 in lowercase hex");
            require!(d.day < head.last_day && d.day > head.v2_through, "only a day the season has moved past");
            require!(!rec.days.contains(&d.day), "day already settled late");
            rec.hash = sha256_hex(&format!("{}|{}|{}|{}", rec.hash, season, d.day, d.digest));
            rec.days.push(d.day);
        }
        self.late.insert(season.clone(), rec.clone());
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({ "standard": "coys", "version": "5.0.0", "event": "days_settled_late",
                "data": [{ "season": season, "days": days.iter().map(|d| near_sdk::serde_json::json!({ "day": d.day, "digest": d.digest })).collect::<Vec<_>>(), "hash": rec.hash }] })
        ));
        rec
    }

    /// A season's days settled late, and their hash.
    pub fn late_days(&self, season: String) -> LateRecord {
        self.late.get(&season).cloned().unwrap_or_else(|| LateRecord { days: Vec::new(), hash: ZERO_HASH.to_string() })
    }

    /// Stores the SHA-256 (hex) of founders.json, once. Owner only.
    pub fn commit_provenance(&mut self, sha256: String) -> String {
        Self::require_owner();
        require!(self.provenance.is_none(), "provenance is already committed");
        require!(hex64_ok(&sha256), "provenance must be 64 lowercase hex characters");
        self.provenance = Some(sha256.clone());
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({ "standard": "coys", "version": "5.0.0", "event": "provenance", "data": [{ "sha256": sha256 }] })
        ));
        sha256
    }

    /// How many Feathers exist, of 777, how many are left, and the provenance hash.
    pub fn feather_supply(&self) -> FeatherSupply {
        let minted = self.feathers_minted - self.returned.len() as u32;
        FeatherSupply { minted, max: FEATHER_MAX, remaining: FEATHER_MAX - minted, provenance: self.provenance.clone(), live_season: self.live_season.clone() }
    }

    /// A season's head, or what it would start from (version 2's last day) if it has none yet.
    pub fn season_head(&self, season: String) -> SeasonHead {
        self.head(&season)
    }

    fn head(&self, season: &str) -> SeasonHead {
        self.heads.get(season).cloned().unwrap_or_else(|| {
            let v2 = self.last_days.get(season).copied().unwrap_or(0);
            SeasonHead {
                last_day: v2,
                last_digest: String::new(),
                chain: ZERO_HASH.to_string(),
                days_settled: 0,
                v2_through: v2,
                pruned_through: 0,
                archive: ZERO_HASH.to_string(),
            }
        })
    }

    /// The day close. Owner only; within a season days arrive in order and each lands once.
    pub fn settle_day(&mut self, batch: DayBatch) -> DaySettled {
        Self::require_owner();
        require!(season_ok(&batch.season), "season must be 1 to 32 characters of a-z, 0-9 and -");
        require!(hex64_ok(&batch.digest), "digest must be the settlement's SHA-256 in lowercase hex");
        let mut head = self.head(&batch.season);
        require!(batch.day > head.last_day, "day already settled");
        require!(batch.hen_mints.is_empty(), "ordinary hens are never minted: only Feathers");
        require!(batch.hen_moves.is_empty(), "there are no hen tokens to move");

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

        let room = FEATHER_MAX - (self.feathers_minted - self.returned.len() as u32);
        require!(batch.feather_mints.len() as u64 <= u64::from(room), "the Feathers are all minted: 777 is the limit");
        if !batch.feather_mints.is_empty() {
            require!(self.live_season.as_deref() == Some(batch.season.as_str()), "only the live season mints Feathers");
        }
        let mut feathers: Vec<TokenId> = Vec::with_capacity(batch.feather_mints.len());
        for f in &batch.feather_mints {
            require!(FEATHER_GRADES.contains(&f.grade.as_str()), "grade must be fluff, plume, quill or golden-quill");
            require!(season_ok(&f.season), "season must be 1 to 32 characters of a-z, 0-9 and -");
            require!(!f.milestone.is_empty() && f.milestone.len() <= 32, "milestone must be 1 to 32 characters");
            require!(f.season == batch.season, "a Feather belongs to the season that mints it");
            // a returned number first (smallest), then the next new one
            let number = if self.returned.is_empty() {
                self.feathers_minted += 1;
                self.feathers_minted
            } else {
                self.returned.remove(0)
            };
            let token_id = feather_token_id(number);
            let extra = near_sdk::serde_json::json!({
                "number": number, "of": FEATHER_MAX, "grade": f.grade, "milestone": f.milestone, "season": f.season, "day": f.day,
                "provenance": self.provenance,
            });
            // the contract pays storage from its own balance: no deposit asked of the caller
            self.feathers.internal_mint_with_refund(
                token_id.clone(),
                f.owner_id.clone(),
                Some(TokenMetadata {
                    title: Some(format!("Feather #{token_id} of {FEATHER_MAX}: {}", grade_label(&f.grade))),
                    description: Some(format!(
                        "A Yolk Street Feather (beta), grade {}, won at the milestone {} on day {} of season {}. A claim ticket planned to hatch into a Founding Hen at mainnet launch.",
                        grade_label(&f.grade),
                        f.milestone,
                        f.day,
                        f.season
                    )),
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
            NftMint { owner_id: &f.owner_id, token_ids: &[token_id.as_str()], memo: Some(&f.grade) }.emit();
            feathers.push(token_id);
        }

        head.chain = sha256_hex(&format!("{}|{}|{}|{}", head.chain, batch.season, batch.day, batch.digest));
        head.last_day = batch.day;
        head.last_digest = batch.digest.clone();
        head.days_settled += 1;
        self.heads.insert(batch.season.clone(), head.clone());
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "coys",
                "version": "5.0.0",
                "event": "day_settled",
                "data": [{ "season": batch.season, "day": batch.day, "digest": batch.digest, "chain": head.chain,
                           "supply": batch.supply, "multiplier_milli": batch.multiplier_milli, "farms": batch.farms.len(),
                           "eggs_minted": U128(minted), "eggs_burned": U128(burned), "egg_transfers": transfers,
                           "feathers": feathers, "feathers_total": self.feathers_minted - self.returned.len() as u32 }],
            })
        ));
        DaySettled { season: batch.season, day: batch.day, chain: head.chain, feathers, eggs_minted: U128(minted), eggs_burned: U128(burned), egg_transfers: transfers }
    }

    /// Releases version 2's day records for a season, oldest first, up to `through` and at most
    /// `limit` of them, folding each into the season's archive hash. Owner only.
    pub fn prune_days(&mut self, season: String, through: u32, limit: u32) -> SeasonHead {
        Self::require_owner();
        require!(season_ok(&season), "season must be 1 to 32 characters of a-z, 0-9 and -");
        let mut head = self.head(&season);
        let end = through.min(head.v2_through).min(head.pruned_through.saturating_add(limit));
        let mut day = head.pruned_through;
        while day < end {
            day += 1;
            let record = self.days.remove(&day_key(&season, day)).or_else(|| if season == LEGACY_SEASON { self.legacy_days.remove(&day) } else { None });
            if let Some(r) = record {
                let json = near_sdk::serde_json::to_string(&r).unwrap_or_else(|_| env::panic_str("record"));
                head.archive = sha256_hex(&format!("{}|{}|{}", head.archive, day, json));
            }
        }
        head.pruned_through = day;
        if head.pruned_through >= head.v2_through {
            self.last_days.remove(&season);
        }
        self.heads.insert(season, head.clone());
        head
    }

    /// A version 2 day record, until `prune_days` releases it.
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
        self.head(&season).last_day
    }

    pub fn egg_grades(&self) -> Vec<String> {
        EGG_GRADES.iter().map(|g| (*g).to_string()).collect()
    }
}

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.feathers.nft_transfer(receiver_id, token_id, approval_id, memo);
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
        self.feathers.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.feathers.nft_token(token_id)
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
        self.feathers.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.feathers.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.feathers.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.feathers.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.feathers.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.feather_metadata.get().unwrap_or_else(|| env::panic_str("no metadata"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;
    use near_sdk_contract_tools::mt::Nep245Controller;

    /// Feather mints per test batch (the server sends at most this many in one day's settlement).
    const MINTS_PER_BATCH: u32 = 20;

    fn ctx(predecessor: AccountId) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(predecessor)
            .storage_usage(10_000_000)
            .build());
    }

    fn feather(owner: AccountId, grade: &str) -> FeatherMint {
        FeatherMint {
            owner_id: owner,
            grade: grade.to_string(),
            milestone: "full-coop".to_string(),
            season: "s1".to_string(),
            day: 4,
            media: "data:image/png;base64,AAAA".to_string(),
            media_hash: Base64VecU8(vec![1, 2, 3]),
        }
    }

    fn digest(day: u32) -> String {
        sha256_hex(&format!("settlement {day}"))
    }

    fn batch(day: u32) -> DayBatch {
        batch_in("s1", day)
    }

    fn batch_in(season: &str, day: u32) -> DayBatch {
        DayBatch {
            season: season.to_string(),
            day,
            digest: digest(day),
            supply: 12,
            multiplier_milli: 1000,
            farms: vec![FarmNet { farm: "f1".into(), account: Some(accounts(1)), net_milli: I64(4200) }],
            eggs: vec![],
            feather_mints: vec![],
            hen_mints: vec![],
            hen_moves: vec![],
        }
    }

    fn record(day: u32) -> DayRecord {
        DayRecord {
            day,
            supply: 93,
            multiplier_milli: 2500,
            digest: "d".repeat(64),
            farms: 3,
            eggs_minted: U128(26),
            eggs_burned: U128(16),
            egg_transfers: 0,
            hens_minted: 0,
            hens_moved: 0,
        }
    }

    /// A version 2 contract with days 1..=last of s1 recorded, written as the stored state.
    fn write_v2(last: u32) {
        let mut days = LookupMap::new(StorageKey::SeasonDays);
        for d in 1..=last {
            days.insert(day_key("s1", d), record(d));
        }
        days.flush();
        let mut last_days = LookupMap::new(StorageKey::SeasonLastDay);
        last_days.insert("s1".to_string(), last);
        last_days.flush();
        let v2 = ContractV2 {
            hens: NonFungibleToken::new(
                StorageKey::HenOwners,
                accounts(0),
                Some(StorageKey::HenMetadata),
                Some(StorageKey::HenEnumeration),
                Some(StorageKey::HenApprovals),
            ),
            hen_metadata: LazyOption::new(StorageKey::HenContractMetadata, None),
            legacy_days: LookupMap::new(StorageKey::Days),
            days,
            last_days,
        };
        env::state_write(&v2);
    }

    #[test]
    fn owner_settles_a_day_with_egg_moves_and_feathers() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        let mut b = batch(1);
        b.eggs = vec![
            EggMove { kind: EggMoveKind::Mint, from: None, to: Some(accounts(1)), grade: "egg-brown".into(), amount: U128(10) },
            EggMove { kind: EggMoveKind::Transfer, from: Some(accounts(1)), to: Some(accounts(2)), grade: "egg-brown".into(), amount: U128(4) },
            EggMove { kind: EggMoveKind::Burn, from: Some(accounts(1)), to: None, grade: "egg-brown".into(), amount: U128(3) },
        ];
        b.feather_mints = vec![feather(accounts(1), "quill"), feather(accounts(1), "golden-quill")];
        let done = c.settle_day(b);
        assert_eq!(done.eggs_minted, U128(10));
        assert_eq!(done.eggs_burned, U128(3));
        assert_eq!(done.feathers, vec!["001".to_string(), "002".to_string()]);
        assert_eq!(c.balance_of("egg-brown", &accounts(1)), 3);
        assert_eq!(c.balance_of("egg-brown", &accounts(2)), 4);
        let token = c.nft_token("002".into()).and_then(|t| t.metadata).unwrap_or_else(|| panic!("no metadata"));
        assert_eq!(token.title.as_deref(), Some("Feather #002 of 777: Golden Quill"));
        let extra: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&token.extra.unwrap_or_default()).unwrap_or_default();
        assert_eq!(extra["grade"], "golden-quill");
        assert_eq!(extra["milestone"], "full-coop");
        assert_eq!(extra["number"], 2);
        assert_eq!(c.feather_supply(), FeatherSupply { minted: 2, max: 777, remaining: 775, provenance: None, live_season: Some("s1".into()) });
        assert_eq!(c.nft_supply_for_owner(accounts(1)), U128(2));
        assert_eq!(c.nft_metadata().name, "Yolk Street Feathers (beta)");
        assert_eq!(c.last_settled_day("s1".into()), 1);
        let head = c.season_head("s1".into());
        assert_eq!(head.last_digest, digest(1));
        assert_eq!(head.chain, sha256_hex(&format!("{ZERO_HASH}|s1|1|{}", digest(1))));
        assert_eq!(c.day_record("s1".into(), 1), None);
    }

    #[test]
    fn a_settled_day_adds_no_storage() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.settle_day(batch(1));
        // the head is written when the state is; measure what each further day leaves behind
        c.heads.flush();
        let after_first = env::storage_usage();
        let mut chain = c.season_head("s1".into()).chain;
        for day in 2..=40 {
            c.settle_day(batch(day));
            chain = sha256_hex(&format!("{chain}|s1|{day}|{}", digest(day)));
        }
        c.heads.flush();
        assert_eq!(env::storage_usage(), after_first);
        let head = c.season_head("s1".into());
        assert_eq!(head.days_settled, 40);
        assert_eq!(head.chain, chain);
    }

    #[test]
    fn an_older_callers_batch_still_settles() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let json = format!(
            r#"{{"season":"s1","day":1,"supply":3,"multiplier_milli":900,"digest":"{}","farms":[{{"farm":"f","account":null,"net_milli":"-5"}}],"eggs":[],"hen_mints":[],"hen_moves":[]}}"#,
            digest(1)
        );
        let b: DayBatch = near_sdk::serde_json::from_str(&json).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(c.settle_day(b).day, 1);
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
    #[should_panic(expected = "digest must be")]
    fn the_digest_is_a_sha256() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut b = batch(1);
        b.digest = "not a hash".into();
        c.settle_day(b);
    }

    #[test]
    fn migrate_upgrades_version_2_in_place_and_prune_releases_its_days() {
        ctx(accounts(0));
        write_v2(30);
        let mut c = Contract::migrate_v2();
        Owner::init(&mut c, &accounts(0));
        assert_eq!(c.last_settled_day("s1".into()), 30);
        assert_eq!(c.day_record("s1".into(), 3), Some(record(3)));
        assert_eq!(c.nft_metadata().name, "Yolk Street Feathers (beta)");
        assert_eq!(c.feather_supply().minted, 0);
        // the season carries on, compact
        c.settle_day(batch(31));
        assert_eq!(c.last_settled_day("s1".into()), 31);
        // release the old records in two calls; the archive hash folds each one in order
        let first = c.prune_days("s1".into(), 30, 12);
        assert_eq!(first.pruned_through, 12);
        let head = c.prune_days("s1".into(), 1000, 1000);
        assert_eq!(head.pruned_through, 30);
        assert_eq!(head.v2_through, 30);
        let mut archive = ZERO_HASH.to_string();
        for d in 1..=30 {
            let json = near_sdk::serde_json::to_string(&record(d)).unwrap_or_default();
            archive = sha256_hex(&format!("{archive}|{d}|{json}"));
        }
        assert_eq!(head.archive, archive);
        assert_eq!(c.day_record("s1".into(), 3), None);
        assert_eq!(c.last_settled_day("s1".into()), 31);
        // nothing more to release
        assert_eq!(c.prune_days("s1".into(), 1000, 1000).archive, archive);
        c.settle_day(batch(32));
        assert_eq!(c.season_head("s1".into()).days_settled, 2);
    }

    #[test]
    fn the_archive_json_matches_the_view() {
        // the archive folds the record exactly as day_record returns it, so anyone can recompute it
        let json = near_sdk::serde_json::to_string(&record(5)).unwrap_or_default();
        assert_eq!(
            json,
            format!(r#"{{"day":5,"supply":93,"multiplier_milli":2500,"digest":"{}","farms":3,"eggs_minted":"26","eggs_burned":"16","egg_transfers":0,"hens_minted":0,"hens_moved":0}}"#, "d".repeat(64))
        );
    }

    #[test]
    fn exactly_777_feathers_then_no_more() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        let mut minted = 0u32;
        let mut day = 1;
        while minted < FEATHER_MAX {
            let mut b = batch_in("s1", day);
            let n = (FEATHER_MAX - minted).min(MINTS_PER_BATCH);
            ctx(accounts(0)); // a fresh call: gas is per transaction
            b.feather_mints = (0..n).map(|i| feather(accounts(1), FEATHER_GRADES[((minted + i) % 4) as usize])).collect();
            c.settle_day(b);
            minted += n;
            day += 1;
        }
        assert_eq!(c.feather_supply().remaining, 0);
        assert!(c.nft_token("777".into()).is_some());
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ctx(accounts(0));
            let mut b = batch_in("s1", day);
            b.feather_mints = vec![feather(accounts(1), "fluff")];
            c.settle_day(b);
        }));
        assert!(refused.is_err());
    }

    #[test]
    #[should_panic(expected = "777 is the limit")]
    fn one_batch_cannot_pass_the_cap() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        c.feathers_minted = 770;
        let mut b = batch(1);
        b.feather_mints = (0..8).map(|_| feather(accounts(1), "plume")).collect();
        c.settle_day(b);
    }

    #[test]
    #[should_panic(expected = "grade must be")]
    fn only_four_feather_grades() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        let mut b = batch(1);
        b.feather_mints = vec![feather(accounts(1), "diamond")];
        c.settle_day(b);
    }

    #[test]
    #[should_panic(expected = "ordinary hens are never minted")]
    fn ordinary_hens_are_refused() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut b = batch(1);
        b.hen_mints = vec![HenMint { token_id: "hen-1".into(), owner_id: accounts(1) }];
        c.settle_day(b);
    }

    #[test]
    fn provenance_is_committed_once() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        let h = digest(9);
        assert_eq!(c.commit_provenance(h.clone()), h);
        assert_eq!(c.feather_supply().provenance, Some(h.clone()));
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ctx(accounts(0));
            c.commit_provenance(digest(10));
        }));
        assert!(again.is_err());
        let mut b = batch(1);
        b.feather_mints = vec![feather(accounts(1), "fluff")];
        ctx(accounts(0));
        c.settle_day(b);
        let extra = c.nft_token("001".into()).and_then(|t| t.metadata).and_then(|m| m.extra).unwrap_or_default();
        assert!(extra.contains(&h));
    }

    #[test]
    #[should_panic(expected = "Owner only")]
    fn others_cannot_settle() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        ctx(accounts(4));
        c.settle_day(batch(1));
    }

    #[test]
    #[should_panic(expected = "Owner only")]
    fn others_cannot_prune() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        ctx(accounts(4));
        c.prune_days("s1".into(), 10, 10);
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
    fn only_four_egg_grades() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        let mut b = batch(1);
        b.eggs = vec![EggMove { kind: EggMoveKind::Mint, from: None, to: Some(accounts(1)), grade: "egg-blue".into(), amount: U128(1) }];
        c.settle_day(b);
    }
    fn feather_in(owner: AccountId, grade: &str, season: &str) -> FeatherMint {
        let mut f = feather(owner, grade);
        f.season = season.to_string();
        f
    }

    #[test]
    #[should_panic(expected = "only the live season mints Feathers")]
    fn a_test_season_cannot_mint_against_the_777() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        let mut b = batch_in("verify-x", 1);
        b.feather_mints = vec![feather_in(accounts(1), "fluff", "verify-x")];
        c.settle_day(b);
    }

    #[test]
    #[should_panic(expected = "only the live season mints Feathers")]
    fn nothing_mints_before_a_live_season_is_set() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        let mut b = batch(1);
        b.feather_mints = vec![feather(accounts(1), "fluff")];
        c.settle_day(b);
    }

    #[test]
    fn test_feathers_burn_and_their_numbers_return_smallest_first() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        // as on testnet: three Feathers from a test season (before the gate existed), then the live season
        c.set_live_season("verify-feathers-1".into());
        let mut b = batch_in("verify-feathers-1", 1);
        b.feather_mints = vec![
            feather_in(accounts(0), "fluff", "verify-feathers-1"),
            feather_in(accounts(0), "quill", "verify-feathers-1"),
            feather_in(accounts(0), "golden-quill", "verify-feathers-1"),
        ];
        c.settle_day(b);
        c.set_live_season("s1".into());
        let mut s1 = batch_in("s1", 1);
        s1.feather_mints = vec![feather(accounts(1), "plume")];
        assert_eq!(c.settle_day(s1).feathers, vec!["004".to_string()]);
        assert_eq!(c.feather_supply().minted, 4);
        // the live season's own Feather is never burnt
        let live = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ctx(accounts(0));
            c.burn_test_feathers(vec!["004".into()]);
        }));
        assert!(live.is_err());
        ctx(accounts(0));
        let supply = c.burn_test_feathers(vec!["002".into(), "001".into(), "003".into()]);
        assert_eq!((supply.minted, supply.remaining), (1, 776));
        assert!(c.nft_token("001".into()).is_none());
        assert_eq!(c.nft_supply_for_owner(accounts(0)), U128(0));
        assert_eq!(c.nft_total_supply(), U128(1));
        // the next Feathers take the returned numbers, smallest first, then new ones
        let mut s2 = batch_in("s1", 2);
        s2.feather_mints = (0..4).map(|_| feather(accounts(1), "fluff")).collect();
        assert_eq!(c.settle_day(s2).feathers, vec!["001", "002", "003", "005"].into_iter().map(String::from).collect::<Vec<_>>());
        assert_eq!(c.feather_supply().minted, 5);
    }

    #[test]
    #[should_panic(expected = "Owner only")]
    fn others_cannot_burn() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.set_live_season("s1".into());
        ctx(accounts(4));
        c.burn_test_feathers(vec!["001".into()]);
    }

    #[test]
    fn missed_days_settle_late_once_each() {
        ctx(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.settle_day(batch(1));
        c.settle_day(batch(4));
        let rec = c.settle_late_days("s1".into(), vec![LateDay { day: 2, digest: digest(2) }, LateDay { day: 3, digest: digest(3) }]);
        let h = sha256_hex(&format!("{}|s1|3|{}", sha256_hex(&format!("{ZERO_HASH}|s1|2|{}", digest(2))), digest(3)));
        assert_eq!(rec, LateRecord { days: vec![2, 3], hash: h });
        assert_eq!(c.late_days("s1".into()).days, vec![2, 3]);
        // the head is untouched and carries on
        assert_eq!(c.last_settled_day("s1".into()), 4);
        c.settle_day(batch(5));
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ctx(accounts(0));
            c.settle_late_days("s1".into(), vec![LateDay { day: 2, digest: digest(2) }]);
        }));
        assert!(again.is_err());
        let ahead = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ctx(accounts(0));
            c.settle_late_days("s1".into(), vec![LateDay { day: 9, digest: digest(9) }]);
        }));
        assert!(ahead.is_err());
    }

    #[test]
    fn migrate_upgrades_version_4_in_place() {
        ctx(accounts(0));
        let mut heads = LookupMap::new(StorageKey::SeasonHeads);
        heads.insert(
            "s1".to_string(),
            SeasonHead { last_day: 520, last_digest: digest(520), chain: digest(1), days_settled: 30, v2_through: 489, pruned_through: 489, archive: digest(2) },
        );
        heads.flush();
        let v4 = ContractV4 {
            feathers: NonFungibleToken::new(
                StorageKey::HenOwners,
                accounts(0),
                Some(StorageKey::HenMetadata),
                Some(StorageKey::HenEnumeration),
                Some(StorageKey::HenApprovals),
            ),
            feather_metadata: LazyOption::new(StorageKey::HenContractMetadata, Some(&feather_metadata())),
            legacy_days: LookupMap::new(StorageKey::Days),
            days: LookupMap::new(StorageKey::SeasonDays),
            last_days: LookupMap::new(StorageKey::SeasonLastDay),
            heads,
            feathers_minted: 3,
            provenance: Some(digest(7)),
        };
        env::state_write(&v4);
        let mut c = Contract::migrate();
        Owner::init(&mut c, &accounts(0));
        assert_eq!(c.last_settled_day("s1".into()), 520);
        assert_eq!(c.feather_supply(), FeatherSupply { minted: 3, max: 777, remaining: 774, provenance: Some(digest(7)), live_season: None });
        c.settle_day(batch(521));
        assert_eq!(c.season_head("s1".into()).days_settled, 31);
    }

}
