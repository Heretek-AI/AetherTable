# Compendium Data Attribution

The `srd_5_2_*.json` fixtures in this directory are derived from the
**System Reference Document 5.2.1** ("SRD 5.1" filenames denote the older
5.1 extraction), parsed from machine-readable markdown published at:

- https://github.com/downfallx/dnd-5e-srd-markdown (markdown conversion)

The SRD contains excised content from the D&D core rulebooks and is licensed
by Wizards of the Coast under **Creative Commons Attribution 4.0 International**
(CC BY 4.0): https://creativecommons.org/licenses/by/4.0/

Per the license, this project attributes the source material to Wizards of the
Coast. The markdown conversion repository is used as a parsing convenience only;
all rules text remains the property of Wizards of the Coast.

---

# Frontend Asset Attribution

Every ingested visual/audio asset is recorded here with source URL, author,
and exact license designation, per the asset-pipeline policy (CC0 / CC-BY /
copyleft only).

## Typography

| Asset | Used for | Author | Source | License |
|-------|----------|--------|--------|---------|
| Cinzel (500/600/700) | Engraved display headers (`.vtt-engraved`) | Natanael Gama | https://fonts.google.com/specimen/Cinzel | SIL Open Font License 1.1 |
| EB Garamond (400–700, italic) | In-world serif prose (`.vtt-parchment`) | Octavio Pardo, Georg Duffner | https://fonts.google.com/specimen/EB+Garamond | SIL Open Font License 1.1 |

Both fonts are loaded from Google Fonts at runtime (`client/src/index.css`);
the OFL permits bundling and redistribution with attribution retained here.

## Icons

| Asset | Used for | Author | Source | License |
|-------|----------|--------|--------|---------|
| lucide-react | All UI iconography | Lucide Contributors | https://lucide.dev | ISC License |

## Audio

All sound effects and ambience loops are **synthesized at runtime** via the
Web Audio API (`client/src/render/audio_manager.ts` — oscillators, filtered
noise buffers). No third-party audio files are ingested, so no external audio
licenses apply.
