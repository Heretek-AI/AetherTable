//! Iteration 86: short-rest mechanics (SRD 5e).
//!
//! Survey finding (pre-iteration): `POST /rest {"kind": "short"}` was a
//! ledgered no-op — no hit-dice pool, no healing, nothing restored. These
//! tests pin the closed gap:
//!   - a serde-defaulted `hit_dice_remaining` pool on [`EntityState`]
//!   - spending dice from that pool heals rolled faces + CON mod per die
//!   - an empty pool spends nothing and heals nothing
//!   - the spend is ledgered (`SHORT_REST_APPLIED` with per-entity payloads)
//!     so a safety rewind past it restores the pre-rest HP exactly like any
//!     other mutation

use vtt_core::dice::DiceEngine;
use vtt_core::state::{EntityState, GameSession};
use vtt_core::AbilityScores;

fn hero(id: &str, hp: i32, ac: i32) -> EntityState {
    let mut e = EntityState::new(
        uuid::Uuid::new_v4(),
        "test".to_string(),
        id.to_string(),
        true,
        hp,
        ac,
        30.0,
        AbilityScores {
            strength: 16,
            dexterity: 14,
            constitution: 14,
            intelligence: 10,
            wisdom: 12,
            charisma: 10,
        },
    );
    e.position = (2.5, 2.5, 0.0);
    e
}

fn session_with_pair() -> GameSession {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Test".into());
    let a = hero("hero-a", 30, 15);
    let b = hero("hero-b", 30, 15);
    let (ia, ib) = (a.id, b.id);
    session.add_entity(a, None).unwrap();
    session.add_entity(b, None).unwrap();
    session.entities.get_mut(&ib).unwrap().is_player = false;
    let _ = ia;
    session
}

// --- (b) the pool ------------------------------------------------------------

#[test]
fn test_entity_defaults_to_empty_hit_dice_pool() {
    let e = hero("fighter", 20, 16);
    assert_eq!(
        e.hit_dice_remaining, 0,
        "serde-defaulted pool starts empty; stat-block import fills it"
    );

    // Legacy serialized entities without the field must still parse.
    let legacy = serde_json::json!({
        "id": uuid::Uuid::new_v4(),
        "compendium_id": "legacy",
        "name": "Legacy",
        "is_player": true,
        "current_hp": 10,
        "max_hp": 10,
        "temp_hp": 0,
        "ac": 12,
        "speed_feet": 30.0,
        "position": [0.0, 0.0, 0.0],
        "zone_id": "Zone_Default",
        "abilities": AbilityScores::default(),
        "conditions": [],
        "action_budget": {
            "action": true, "bonus_action": true, "reaction": true,
            "movement_remaining_feet": 30.0, "free_object_interaction": true
        },
        "spell_slots_remaining": {},
        "inventory": {"items": {}},
        "is_conscious": true,
        "is_dead": false,
        "is_visible": true
    });
    let parsed: EntityState =
        serde_json::from_value(legacy).expect("payload without hit_dice must parse");
    assert_eq!(parsed.hit_dice_remaining, 0);

    // And a modern payload round-trips its pool.
    let mut stocked = hero("bard", 24, 14);
    stocked.hit_dice_remaining = 5;
    let json = serde_json::to_string(&stocked).unwrap();
    assert!(json.contains("hit_dice"), "pool must serialize: {json}");
    let back: EntityState = serde_json::from_str(&json).unwrap();
    assert_eq!(back.hit_dice_remaining, 5);
}

// --- (c) spending: roll per die + CON mod -----------------------------------

#[test]
fn test_spend_hit_dice_heals_rolled_plus_con_per_die_and_spends_pool() {
    let mut session = session_with_pair();
    let id = *session.entities.keys().next().unwrap();

    {
        let e = session.entities.get_mut(&id).unwrap();
        e.current_hp = 5;
        e.max_hp = 30;
        e.hit_dice_size = 8;
        e.hit_dice_remaining = 3;
    }

    // Twin engine: the same seed must reproduce the exact faces the spend
    // drew, pinning "healing = sum(faces) + CON mod per die" without
    // hardcoding RNG internals.
    let expected_faces: Vec<i32> = {
        let mut twin = DiceEngine::with_seed(86);
        (0..2).map(|_| twin.roll_die(8)).collect()
    };
    let mut dice = DiceEngine::with_seed(86);
    let report = {
        let e = session.entities.get_mut(&id).unwrap();
        e.spend_hit_dice(&mut dice, 2)
            .expect("pool of 3 can fund a two-die spend")
    };
    assert_eq!(report.rolls, expected_faces);

    assert_eq!(report.dice_spent, 2);
    assert_eq!(report.hp_before, 5);
    // 2d8 + 2 x (+2 CON) — clamped at the 30 max.
    assert_eq!(report.healing, report.rolls.iter().sum::<i32>() + 4);
    let expected_hp = (5 + report.healing).min(30);
    assert_eq!(report.hp_after, expected_hp);
    assert_eq!(
        session.entities[&id].hit_dice_remaining, 1,
        "the spend draws down the pool by exactly the dice used"
    );
}

#[test]
fn test_spend_hit_dice_never_exceeds_max_hp_or_the_pool() {
    let mut session = session_with_pair();
    let id = *session.entities.keys().next().unwrap();

    {
        let e = session.entities.get_mut(&id).unwrap();
        // Near-full: any positive roll overshoots max (10) and must clamp.
        e.current_hp = 9;
        e.max_hp = 10;
        e.hit_dice_size = 6;
        e.hit_dice_remaining = 2;
    }

    let mut dice = DiceEngine::with_seed(7);
    let report = {
        let e = session.entities.get_mut(&id).unwrap();
        e.spend_hit_dice(&mut dice, 1).unwrap()
    };
    assert_eq!(session.entities[&id].current_hp, 10, "heal clamps at max");
    assert_eq!(report.hp_after, 10);

    // A spend larger than the pool is refused whole — no partial draw-down.
    let err = session
        .entities
        .get_mut(&id)
        .unwrap()
        .spend_hit_dice(&mut dice, 5)
        .expect_err("only one die left in the pool");
    assert!(err.contains("hit dice"), "error should name the resource: {err}");
    assert_eq!(
        session.entities[&id].hit_dice_remaining, 1,
        "refused spend leaves the pool untouched"
    );
}

#[test]
fn test_spend_hit_dice_with_no_dice_is_a_noop_error_not_a_crash() {
    let mut session = session_with_pair();
    let id = *session.entities.keys().next().unwrap();
    {
        let e = session.entities.get_mut(&id).unwrap();
        e.current_hp = 4;
        e.max_hp = 20;
        e.hit_dice_size = 8;
        e.hit_dice_remaining = 0;
    }

    let mut dice = DiceEngine::with_seed(1);
    let err = session
        .entities
        .get_mut(&id)
        .unwrap()
        .spend_hit_dice(&mut dice, 1)
        .expect_err("empty pool cannot fund a rest-heal");
    assert!(err.contains("hit dice"));
    assert_eq!(session.entities[&id].current_hp, 4);
    assert_eq!(session.entities[&id].hit_dice_remaining, 0);

    // Zero requested is also refused rather than rolling nothing.
    let err = session
        .entities
        .get_mut(&id)
        .unwrap()
        .spend_hit_dice(&mut dice, 0)
        .expect_err("zero dice is not a spend");
    assert!(err.contains("at least one"), "{err}");
}

// --- (d) ledger + rewind consistency ----------------------------------------

#[test]
fn test_short_rest_ledger_event_replays_on_safety_rewind() {
    let mut session = session_with_pair();
    let (a_id, b_id): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    // Baseline: B battered to 12 HP.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        serde_json::json!({
            "target_id": b_id.to_string(),
            "total_damage": 18,
            "target_hp_remaining": 12,
            "target_is_conscious": true,
            "target_is_dead": false,
        }),
    );

    // B short-rests, spending one die for a deterministic 5 (+2 CON) heal.
    let seq_after_rest = {
        let e = session.entities.get_mut(&b_id).unwrap();
        e.max_hp = 30;
        e.current_hp = 12;
        e.hit_dice_size = 8;
        e.hit_dice_remaining = 2;
        let mut dice = DiceEngine::with_seed(99);
        let report = session
            .entities
            .get_mut(&b_id)
            .unwrap()
            .spend_hit_dice(&mut dice, 1)
            .unwrap();
        assert!(report.healing > 0, "the roll must heal at least 1 + CON");
        session
            .ledger
            .append_event(
                session.session_id,
                session.campaign_id,
                b_id,
                "SHORT_REST_APPLIED",
                serde_json::json!({
                    "triggered_by": "tester",
                    "target_id": b_id.to_string(),
                    "dice_spent": report.dice_spent,
                    "rolls": report.rolls,
                    "con_modifier": report.con_modifier,
                    "healing": report.healing,
                    "hp_remaining": report.hp_after,
                    "hit_dice_remaining": session.entities[&b_id].hit_dice_remaining,
                }),
            )
            .sequence_id
    };
    assert_eq!(seq_after_rest, 4, "two spawns + baseline attack precede it");

    // Then another wound lands — the one a rewind will discard.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        serde_json::json!({
            "target_id": b_id.to_string(),
            "total_damage": 30,
            "target_hp_remaining": 0,
            "target_is_conscious": false,
            "target_is_dead": false,
        }),
    );
    session.entities.get_mut(&b_id).unwrap().current_hp = 0;
    session.entities.get_mut(&b_id).unwrap().is_conscious = false;

    session.safety_rewind(seq_after_rest);

    let post_rest_hp = session.entities[&b_id].current_hp;
    // One d8 + 2 CON from the wounded 12 heals into 15..=22 (max-HP clamp at
    // 30 never binds); the discarded attack's 0 must NOT win.
    assert!(
        (15..=22).contains(&post_rest_hp),
        "rewind must land on the post-short-rest HP ({post_rest_hp}), not the discarded attack's 0"
    );
    assert!(session.entities[&b_id].is_conscious);
}

#[test]
fn test_safety_rewind_past_short_rest_event_leaves_nothing_to_restore() {
    // The old no-op contract survives for events WITHOUT target payloads:
    // a surviving legacy SHORT_REST_APPLIED must change nothing during replay.
    let mut session = session_with_pair();
    let (a_id, b_id): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        serde_json::json!({
            "target_id": b_id.to_string(),
            "total_damage": 10,
            "target_hp_remaining": 20,
            "target_is_conscious": true,
            "target_is_dead": false,
        }),
    );
    let seq = session
        .ledger
        .append_event(
            session.session_id,
            session.campaign_id,
            uuid::Uuid::nil(),
            "SHORT_REST_APPLIED",
            serde_json::json!({"triggered_by": "tester"}),
        )
        .sequence_id;
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        serde_json::json!({
            "target_id": b_id.to_string(),
            "total_damage": 25,
            "target_hp_remaining": 5,
            "target_is_conscious": true,
            "target_is_dead": false,
        }),
    );
    session.entities.get_mut(&b_id).unwrap().current_hp = 5;

    let report = session.safety_rewind(seq);

    assert_eq!(report.reverted_event_count, 1);
    assert_eq!(
        session.entities[&b_id].current_hp, 20,
        "a legacy payload-less short-rest event stays a replay no-op"
    );
}
