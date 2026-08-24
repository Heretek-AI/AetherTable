import React from 'react';

/**
 * Official-5e-book stat block renderer, shared by CompendiumView,
 * SpellbookModal and EncounterBuilder. Purely presentational over the SRD
 * compendium JSON shapes:
 *   monsters → {name,size,creature_type,alignment,ac,hp,hit_dice,speed,
 *               abilities,traits,actions,challenge_rating,xp}
 *   spells   → {name,level,school,casting_time,range,components,duration,
 *               concentration,ritual,classes,description}
 *   items    → {name,item_type,rarity,requires_attunement,description}
 */

export type StatblockKind = 'monster' | 'spell' | 'item';

interface StatblockProps {
  item: Record<string, any>;
  kind: StatblockKind;
}

/** Small-caps crimson trait header with italic gist, book style. */
function Trait({ name, text }: { name: string; text: string }) {
  return (
    <p className="selectable-text leading-relaxed">
      <span className="vtt-inline-trait mr-1">{name}.</span>
      <span className="italic">{text}</span>
    </p>
  );
}

const ORDINALS = ['Cantrip', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

export function Statblock({ item, kind }: StatblockProps) {
  const attrs: [string, React.ReactNode][] = [];
  let tagline = '';
  let meta: string[] = [];

  if (kind === 'monster') {
    tagline = [item.size, item.creature_type, item.alignment].filter(Boolean).join(', ');
    // Book attribute strip: armor, hit points (with dice expression), speed.
    attrs.push(
      ['Armor Class', item.ac],
      ['Hit Points', item.hp ? `${item.hp}${item.hit_dice ? ` (${item.hit_dice})` : ''}` : null],
      ['Speed', item.speed],
    );
    meta = [
      item.challenge_rating != null ? `CR ${item.challenge_rating}` : '',
      item.xp != null ? `${Number(item.xp).toLocaleString()} XP` : '',
    ].filter(Boolean);
  } else if (kind === 'spell') {
    const lvl = typeof item.level === 'number' ? ORDINALS[item.level] ?? `${item.level}` : item.level;
    tagline = `${lvl !== 'Cantrip' && lvl ? `${lvl}-level ` : ''}${item.school ?? ''}`.trim();
    attrs.push(
      ['Casting Time', item.casting_time],
      ['Range', item.range],
      ['Duration', item.duration],
    );
    if (Array.isArray(item.classes) && item.classes.length > 0) {
      meta = [`Classes: ${item.classes.join(', ')}`];
    }
  } else {
    tagline = [item.item_type, item.rarity].filter(Boolean).join(', ');
    if (item.requires_attunement) tagline += ' (requires attunement)';
  }

  const traitGroups: [string, any[] | undefined][] =
    kind === 'monster'
      ? [['Traits', item.traits], ['Actions', item.actions], ['Legendary Actions', item.legendary_actions]]
      : [];

  return (
    <div className="selectable-text">
      {/* Name plate */}
      <h3 className="vtt-statblock-nameplate text-2xl font-bold">{item.name}</h3>
      <p className="vtt-statblock-tagline mt-0.5">{tagline || ' '}</p>

      {/* Attribute strip — labels differentiate entries, not color coding */}
      {attrs.some(([, v]) => v != null && v !== '') && (
        <dl className="vtt-statblock-attr grid grid-cols-3 gap-2 px-3 py-2 my-2 rounded-sm">
          {attrs.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="vtt-attr-label text-[11px] leading-tight">{label}</dt>
              <dd className="vtt-attr-value text-sm truncate" title={String(value ?? '')}>
                {value ?? '—'}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Meta badges (CR/XP or class list) */}
      {meta.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {meta.map((m) => (
            <span key={m} className="vtt-badge">{m}</span>
          ))}
        </div>
      )}

      <div className="vtt-divider my-2"><span /></div>

      {/* Body prose — opening paragraph gets the printed-book drop cap */}
      {item.description && (
        <p className="vtt-dropcap leading-relaxed">{item.description}</p>
      )}

      {traitGroups.map(
        ([group, entries]) =>
          Array.isArray(entries) &&
          entries.length > 0 && (
            <section key={group} className="mt-3 space-y-1.5">
              <h4 className="vtt-section-header text-sm font-bold">{group}</h4>
              {entries.map(
                (t: any, i: number) =>
                  t?.name && <Trait key={`${group}-${i}`} name={t.name} text={t.description ?? ''} />
              )}
            </section>
          )
      )}

      {/* Spell upcast note, rendered like a book sidebar note */}
      {kind === 'spell' && item.upcast && (
        <section className="mt-3">
          <h4 className="vtt-section-header text-sm font-bold">At Higher Levels</h4>
          <p className="leading-relaxed italic">{item.upcast}</p>
        </section>
      )}
    </div>
  );
}
