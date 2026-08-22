---
name: vtt-architecture
description: "AI-Native Virtual Tabletop (VTT) engineering and architecture skill. Provides formulas, subsystem invariants, spatial audio acoustics, WFC map synthesis schemas, .vttbundle packager specs, and multi-agent auditor guidelines for developing and extending the TTRPG engine."
argument-hint: "[subsystem] [action] [invariants]"
license: MIT
metadata:
  author: Heretek-AI
  version: "1.0.0"
---

# VTT Architecture & Subsystem Specification Skill

This skill contains the complete engineering reference, mathematical formulas, data schemas, and invariant contracts for the **Autonomous AI-Native Virtual Tabletop (VTT)** platform.

---

## 1. Mathematical Formulas & Rules Contracts

### **A. Ability Modifiers & Proficiency Scaling**
* **Floored Ability Modifier**: $\text{Mod} = \lfloor \frac{\text{Score} - 10}{2} \rfloor$ (`(score - 10).div_euclid(2)`)
* **Proficiency Bonus**: $\text{PB} = 2 + \lfloor \frac{\text{Level} - 1}{4} \rfloor$

### **B. Armor Class Derivations**
* **Unarmored**: $10 + \text{DEX}$
* **Barbarian Unarmored**: $10 + \text{DEX} + \text{CON}$
* **Monk Unarmored**: $10 + \text{DEX} + \text{WIS}$
* **Light Armor**: $\text{Base} + \text{DEX}$
* **Medium Armor**: $\text{Base} + \min(\text{DEX}, 2)$
* **Heavy Armor**: $\text{Base}$ (no DEX modifier)
* **Shield Bonus**: $+2\text{ AC}$

### **C. 3D Web Audio Spatial Geometry**
* Listener coordinates $(L_x, L_y)$, Source coordinates $(S_x, S_y)$:
* **Stereo Pan**: $p = \text{clamp}\left(\frac{S_x - L_x}{8.0}, -1.0, 1.0\right)$
* **Inverse-Distance Gain**: $g = \text{clamp}\left(\frac{1.0}{1.0 + \text{dist} \times 0.15}, 0.08, 1.0\right)$
* **Concentration DC**: $\text{DC} = \max(10, \lfloor \text{damage} / 2 \rfloor)$

---

## 2. Invariant Contracts

1. **Deterministic Authority**: All dice rolls, saving throws, modifier evaluations, and combat resolutions occur in pure Rust (`crates/vtt-core`).
2. **Pre-Commit Invariant Interceptor**: Every narrative draft from the DM Agent must be validated by `PreCommitAuditorAgent` before committing state mutations.
3. **Bundle Format (`.vttbundle`)**:
   * Standard ZIP archive containing:
     * `manifest.json` (version, name, author)
     * `map_layout.json` (grid width/height, tiles)
     * `tokens.json` (entities, stats, coords)
     * `dynasties.json` (noble houses, family trees)
     * `lore_graph.json` (epistemic nodes & edges)
     * `loot_tables.json` (drop rates, item archetypes)

---

## 3. Standard Test Commands

```bash
# Run full multi-service benchmark suite
./scripts/run_all_benchmarks.sh

# Run Rust engine tests
cargo test --workspace

# Run Python multi-agent tests
PYTHONPATH=python pytest python/tests
```
