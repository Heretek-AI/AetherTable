/**
 * Instant Client Safety Tools (X-Card / Fast-Forward).
 */

export class SafetyUIControls {
  private onTriggerXCard: (topic: string) => void;

  constructor(onTriggerXCard: (topic: string) => void) {
    this.onTriggerXCard = onTriggerXCard;
  }

  public triggerXCard(topic: string = 'General'): void {
    console.warn(`[Safety UI] X-CARD INVOKED on topic: ${topic}`);
    this.onTriggerXCard(topic);
  }
}
