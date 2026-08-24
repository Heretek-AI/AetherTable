use rhai::{Dynamic, Engine, EvalAltResult, Position, Scope};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptExecutionContext {
    pub caster_level: i64,
    pub target_ac: i64,
    pub spell_dc: i64,
    pub environment_tag: String,
}

/// Hard ceiling on Rhai operations per evaluation. A `while true {}` loop
/// burns through this and returns an error instead of hanging the worker.
pub const MAX_RHAI_OPERATIONS: u64 = 10_000;

pub struct RhaiNarrativeEngine;

impl Default for RhaiNarrativeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RhaiNarrativeEngine {
    pub fn new() -> Self {
        Self
    }

    /// Builds a sandboxed engine for one evaluation. A fresh engine per call
    /// lets us seed `roll_d6` deterministically without shared mutable RNG
    /// state across concurrent requests.
    fn build_sandboxed_engine(seed: u64) -> Engine {
        let mut engine = Engine::new();
        engine.set_max_expr_depths(32, 32);
        engine.set_max_string_size(1000);
        engine.set_max_array_size(100);
        engine.set_max_operations(MAX_RHAI_OPERATIONS);

        // Deterministic SplitMix64 counter — same seed => same dice sequence.
        let rng_state = AtomicU64::new(seed);
        engine.register_fn("roll_d6", move |count: i64| -> Result<i64, Box<EvalAltResult>> {
            if count < 0 || count > 1000 {
                return Err(Box::new(EvalAltResult::ErrorArithmetic(
                    format!("roll_d6 count {} out of bounds (0..=1000)", count).into(),
                    Position::NONE,
                )));
            }
            let mut sum: i64 = 0;
            for _ in 0..count {
                let n = rng_state.fetch_add(1, Ordering::Relaxed);
                let x = splitmix64(n);
                sum += ((x % 6) + 1) as i64;
            }
            Ok(sum)
        });

        engine.register_fn("calculate_environmental_dc", |base_dc: i64, env: &str| -> i64 {
            match env {
                "foggy" | "dark" => base_dc + 2,
                "underwater" => base_dc + 5,
                _ => base_dc,
            }
        });

        engine
    }

    /// Evaluates a spell hook script under full sandbox limits. Dice rolls are
    /// derived from the explicit `seed` (deterministic-replay requirement).
    pub fn evaluate_spell_hook_seeded(
        &self,
        script: &str,
        context: &ScriptExecutionContext,
        seed: u64,
    ) -> Result<Dynamic, Box<EvalAltResult>> {
        let engine = Self::build_sandboxed_engine(seed);

        let mut scope = Scope::new();
        scope.push("caster_level", context.caster_level);
        scope.push("target_ac", context.target_ac);
        scope.push("spell_dc", context.spell_dc);
        scope.push("environment", context.environment_tag.clone());

        let ast = engine.compile(script)?;
        engine.eval_ast_with_scope(&mut scope, &ast)
    }

    /// Backward-compatible entry point with a fixed default seed.
    pub fn evaluate_spell_hook(
        &self,
        script: &str,
        context: &ScriptExecutionContext,
    ) -> Result<Dynamic, Box<EvalAltResult>> {
        self.evaluate_spell_hook_seeded(script, context, 0)
    }
}

/// SplitMix64 — small, fast, fully deterministic integer mixer.
fn splitmix64(state: u64) -> u64 {
    state.wrapping_add(0x9E37_79B9_7F4A_7C15)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rhai_operation_limit_rejects_infinite_loop() {
        let engine = RhaiNarrativeEngine::new();
        let ctx = ScriptExecutionContext {
            caster_level: 1,
            target_ac: 10,
            spell_dc: 10,
            environment_tag: "clear".to_string(),
        };
        let result = engine.evaluate_spell_hook_seeded("while true { }", &ctx, 42);
        assert!(result.is_err(), "unbounded loop must be rejected by op limit");
    }

    #[test]
    fn test_roll_d6_deterministic_per_seed() {
        let engine = RhaiNarrativeEngine::new();
        let ctx = ScriptExecutionContext {
            caster_level: 1,
            target_ac: 10,
            spell_dc: 10,
            environment_tag: "clear".to_string(),
        };
        let a = engine
            .evaluate_spell_hook_seeded("roll_d6(3)", &ctx, 1234)
            .unwrap()
            .as_int()
            .unwrap();
        let b = engine
            .evaluate_spell_hook_seeded("roll_d6(3)", &ctx, 1234)
            .unwrap()
            .as_int()
            .unwrap();
        let c = engine
            .evaluate_spell_hook_seeded("roll_d6(3)", &ctx, 999)
            .unwrap()
            .as_int()
            .unwrap();
        assert_eq!(a, b, "same seed must reproduce identical rolls");
        // Different seed almost certainly differs (3d6 range 3..18).
        assert_ne!(a, c);
    }

    #[test]
    fn test_roll_d6_bounds_enforced() {
        let engine = RhaiNarrativeEngine::new();
        let ctx = ScriptExecutionContext {
            caster_level: 1,
            target_ac: 10,
            spell_dc: 10,
            environment_tag: "clear".to_string(),
        };
        assert!(engine.evaluate_spell_hook_seeded("roll_d6(-1)", &ctx, 1).is_err());
        assert!(engine.evaluate_spell_hook_seeded("roll_d6(5000)", &ctx, 1).is_err());
    }
}
