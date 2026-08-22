pub mod rhai_engine;
pub mod wasm_engine;

pub use rhai_engine::{RhaiNarrativeEngine, ScriptExecutionContext};
pub use wasm_engine::{SandboxedWasmEngine, WasmExecutionResult};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wasm_fuel_metering() {
        let engine = SandboxedWasmEngine::new().unwrap();
        // WAT module: add two numbers
        let wat = r#"
            (module
                (func (export "custom_damage_modifier") (param i32 i32) (result i32)
                    local.get 0
                    local.get 1
                    i32.add
                )
            )
        "#;

        let res = engine.execute_wat(wat, "custom_damage_modifier", &[10, 5], 50000);
        assert!(res.is_ok());
        let val = res.unwrap();
        assert_eq!(val.output_value, 15);
        assert!(val.fuel_consumed > 0);
        assert!(val.fuel_consumed < 50000);
    }

    #[test]
    fn test_wasm_fuel_exhaustion_protection() {
        let engine = SandboxedWasmEngine::new().unwrap();
        // WAT module: infinite loop
        let wat = r#"
            (module
                (func (export "infinite_loop") (param i32) (result i32)
                    (loop
                        br 0
                    )
                    i32.const 1
                )
            )
        "#;

        let res = engine.execute_wat(wat, "infinite_loop", &[1], 500);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fuel"));
    }

    #[test]
    fn test_rhai_scripting_engine() {
        let engine = RhaiNarrativeEngine::new();
        let ctx = ScriptExecutionContext {
            caster_level: 5,
            target_ac: 14,
            spell_dc: 15,
            environment_tag: "foggy".to_string(),
        };

        let script = r#"
            let dc = calculate_environmental_dc(spell_dc, environment);
            let bonus_dmg = if caster_level >= 5 { 10 } else { 0 };
            dc + bonus_dmg
        "#;

        let res = engine.evaluate_spell_hook(script, &ctx).unwrap();
        // base 15 + foggy 2 = 17, level 5 bonus 10 -> 27
        assert_eq!(res.as_int().unwrap(), 27);
    }
}
