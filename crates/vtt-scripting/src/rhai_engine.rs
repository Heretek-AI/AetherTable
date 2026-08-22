use rhai::{Dynamic, Engine, EvalAltResult, Scope};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptExecutionContext {
    pub caster_level: i64,
    pub target_ac: i64,
    pub spell_dc: i64,
    pub environment_tag: String,
}

pub struct RhaiNarrativeEngine {
    engine: Engine,
}

impl Default for RhaiNarrativeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RhaiNarrativeEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();
        engine.set_max_expr_depths(32, 32);
        engine.set_max_string_size(1000);
        engine.set_max_array_size(100);

        engine.register_fn("roll_d6", |count: i64| -> i64 {
            let mut sum = 0;
            for _ in 0..count {
                sum += (rand::random::<u32>() % 6 + 1) as i64;
            }
            sum
        });

        engine.register_fn("calculate_environmental_dc", |base_dc: i64, env: &str| -> i64 {
            match env {
                "foggy" | "dark" => base_dc + 2,
                "underwater" => base_dc + 5,
                _ => base_dc,
            }
        });

        Self { engine }
    }

    pub fn evaluate_spell_hook(
        &self,
        script: &str,
        context: &ScriptExecutionContext,
    ) -> Result<Dynamic, Box<EvalAltResult>> {
        let mut scope = Scope::new();
        scope.push("caster_level", context.caster_level);
        scope.push("target_ac", context.target_ac);
        scope.push("spell_dc", context.spell_dc);
        scope.push("environment", context.environment_tag.clone());

        let ast = self.engine.compile(script)?;
        self.engine.eval_ast_with_scope(&mut scope, &ast)
    }
}
