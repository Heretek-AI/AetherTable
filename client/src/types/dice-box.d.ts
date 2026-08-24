// @3d-dice/dice-box ships no TypeScript declarations.
declare module '@3d-dice/dice-box' {
  const DiceBox: new (config: Record<string, unknown>) => {
    init: () => Promise<unknown>;
    roll: (rolls: Array<Record<string, unknown>>) => Promise<unknown> | unknown;
    add: (rolls: Array<Record<string, unknown>>) => unknown;
    clear: () => void;
    destroy: () => void;
  };
  export default DiceBox;
}
