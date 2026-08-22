use serde::{Deserialize, Serialize};
use wasmtime::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmExecutionResult {
    pub output_value: i32,
    pub fuel_consumed: u64,
    pub execution_time_micros: u64,
}

pub struct SandboxedWasmEngine {
    engine: Engine,
}

impl Default for SandboxedWasmEngine {
    fn default() -> Self {
        Self::new().expect("Failed to initialize Wasmtime engine")
    }
}

impl SandboxedWasmEngine {
    pub fn new() -> anyhow::Result<Self> {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config)?;
        Ok(Self { engine })
    }

    pub fn execute_wat(
        &self,
        wat_source: &str,
        function_name: &str,
        params: &[i32],
        fuel_limit: u64,
    ) -> Result<WasmExecutionResult, String> {
        let start_time = std::time::Instant::now();
        let module = Module::new(&self.engine, wat_source).map_err(|e| format!("Module compile error: {}", e))?;
        let mut store = Store::new(&self.engine, ());
        store.set_fuel(fuel_limit).map_err(|e| format!("Fuel config error: {}", e))?;

        let instance = Instance::new(&mut store, &module, &[])
            .map_err(|e| format!("Instance error: {}", e))?;

        let func = instance
            .get_func(&mut store, function_name)
            .ok_or_else(|| format!("Function '{}' not found", function_name))?;

        let wasm_params: Vec<Val> = params.iter().map(|&p| Val::I32(p)).collect();
        let mut results = vec![Val::I32(0)];

        func.call(&mut store, &wasm_params, &mut results)
            .map_err(|e| format!("WASM runtime execution failed (fuel exhausted or trap): {}", e))?;

        let remaining_fuel = store.get_fuel().unwrap_or(0);
        let fuel_consumed = fuel_limit.saturating_sub(remaining_fuel);
        let elapsed = start_time.elapsed().as_micros() as u64;

        let output_val = match results.first() {
            Some(Val::I32(v)) => *v,
            _ => 0,
        };

        Ok(WasmExecutionResult {
            output_value: output_val,
            fuel_consumed,
            execution_time_micros: elapsed,
        })
    }
}
