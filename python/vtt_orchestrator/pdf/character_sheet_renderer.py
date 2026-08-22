import io
from typing import Dict, Any, List
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    KeepTogether,
    PageBreak,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle


class CharacterSheetPDFRenderer:
    """
    Renders official-style vector 5e Character Sheets and Spell Grimoire pages.
    """

    def __init__(self):
        self.styles = getSampleStyleSheet()
        self._init_custom_styles()

    def _init_custom_styles(self):
        self.title_style = ParagraphStyle(
            "SheetTitle",
            parent=self.styles["Heading1"],
            fontSize=18,
            leading=22,
            textColor=colors.HexColor("#1e1b4b"),
            fontName="Helvetica-Bold",
        )
        self.subtitle_style = ParagraphStyle(
            "SheetSubtitle",
            parent=self.styles["Normal"],
            fontSize=9,
            leading=12,
            textColor=colors.HexColor("#475569"),
            fontName="Helvetica",
        )
        self.section_header = ParagraphStyle(
            "SectionHeader",
            parent=self.styles["Heading2"],
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#4338ca"),
            fontName="Helvetica-Bold",
            spaceAfter=4,
        )
        self.stat_label = ParagraphStyle(
            "StatLabel",
            parent=self.styles["Normal"],
            fontSize=7,
            leading=8,
            textColor=colors.HexColor("#64748b"),
            fontName="Helvetica-Bold",
            alignment=1,  # Center
        )
        self.stat_val = ParagraphStyle(
            "StatVal",
            parent=self.styles["Normal"],
            fontSize=13,
            leading=15,
            textColor=colors.HexColor("#0f172a"),
            fontName="Helvetica-Bold",
            alignment=1,  # Center
        )
        self.body_small = ParagraphStyle(
            "BodySmall",
            parent=self.styles["Normal"],
            fontSize=8,
            leading=11,
            textColor=colors.HexColor("#1e293b"),
        )

    def render_pdf_bytes(self, char_data: Dict[str, Any]) -> bytes:
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=letter,
            leftMargin=36,
            rightMargin=36,
            topMargin=36,
            bottomMargin=36,
        )
        story = []

        # 1. Header Banner
        name = char_data.get("name", "Unnamed Hero")
        cls_lvl = f"Level {char_data.get('level', 1)} {char_data.get('class_name', 'Fighter')}"
        race = char_data.get("race", "Human")
        background = char_data.get("background", "Soldier")

        header_data = [
            [
                Paragraph(f"<b>{name}</b>", self.title_style),
                Paragraph(f"<b>Class & Level:</b> {cls_lvl}<br/><b>Race:</b> {race}", self.subtitle_style),
                Paragraph(f"<b>Background:</b> {background}<br/><b>Alignment:</b> {char_data.get('alignment', 'Neutral Good')}", self.subtitle_style),
            ]
        ]
        header_table = Table(header_data, colWidths=[200, 170, 170])
        header_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 1.5, colors.HexColor("#6366f1")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(header_table)
        story.append(Spacer(1, 10))

        # 2. Top Combat Strip: AC, Initiative, Speed, HP
        ac = char_data.get("ac", 16)
        hp = char_data.get("hp", 28)
        max_hp = char_data.get("max_hp", 28)
        speed = char_data.get("speed", "30 ft")
        prof_bonus = (char_data.get("level", 1) - 1) // 4 + 2

        vitals_data = [
            [
                Paragraph("ARMOR CLASS", self.stat_label),
                Paragraph("PROFICIENCY", self.stat_label),
                Paragraph("SPEED", self.stat_label),
                Paragraph("HIT POINTS", self.stat_label),
                Paragraph("PASSIVE PERCEPTION", self.stat_label),
            ],
            [
                Paragraph(f"<b>{ac}</b>", self.stat_val),
                Paragraph(f"<b>+{prof_bonus}</b>", self.stat_val),
                Paragraph(f"<b>{speed}</b>", self.stat_val),
                Paragraph(f"<b>{hp} / {max_hp}</b>", self.stat_val),
                Paragraph(f"<b>{char_data.get('passive_perception', 13)}</b>", self.stat_val),
            ]
        ]
        vitals_table = Table(vitals_data, colWidths=[108, 108, 108, 108, 108])
        vitals_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
            ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(vitals_table)
        story.append(Spacer(1, 12))

        # 3. Ability Scores Row
        abilities = [
            ("STR", char_data.get("str_score", 16)),
            ("DEX", char_data.get("dex_score", 14)),
            ("CON", char_data.get("con_score", 15)),
            ("INT", char_data.get("int_score", 10)),
            ("WIS", char_data.get("wis_score", 12)),
            ("CHA", char_data.get("cha_score", 8)),
        ]

        def mod_str(val: int) -> str:
            m = (val - 10) // 2
            return f"+{m}" if m >= 0 else f"{m}"

        ability_headers = [Paragraph(f"<b>{abbr}</b>", self.stat_label) for abbr, _ in abilities]
        ability_mods = [Paragraph(f"<b>{mod_str(score)}</b>", self.stat_val) for _, score in abilities]
        ability_scores = [Paragraph(f"Score: {score}", self.stat_label) for _, score in abilities]

        ability_table = Table([ability_headers, ability_mods, ability_scores], colWidths=[90] * 6)
        ability_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#ede9fe")),
            ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#8b5cf6")),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c4b5fd")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(ability_table)
        story.append(Spacer(1, 12))

        # 4. Actions & Attacks Table
        story.append(Paragraph("Attacks & Combat Actions", self.section_header))
        actions = char_data.get("actions", [
            {"name": "Greataxe", "atk": f"+{char_data.get('str_mod', 3) + prof_bonus}", "damage": "1d12 + 3 Slashing", "range": "Melee (5 ft)"},
            {"name": "Javelin", "atk": f"+{char_data.get('str_mod', 3) + prof_bonus}", "damage": "1d6 + 3 Piercing", "range": "30/120 ft"},
        ])

        atk_rows = [
            [
                Paragraph("<b>ACTION NAME</b>", self.stat_label),
                Paragraph("<b>ATTACK BONUS</b>", self.stat_label),
                Paragraph("<b>DAMAGE / TYPE</b>", self.stat_label),
                Paragraph("<b>RANGE / REACH</b>", self.stat_label),
            ]
        ]
        for a in actions:
            atk_rows.append([
                Paragraph(f"<b>{a.get('name', 'Strike')}</b>", self.body_small),
                Paragraph(f"{a.get('atk', '+5')}", self.body_small),
                Paragraph(f"{a.get('damage', '1d8+3')}", self.body_small),
                Paragraph(f"{a.get('range', '5 ft')}", self.body_small),
            ])

        atk_table = Table(atk_rows, colWidths=[150, 100, 160, 130])
        atk_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
            ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#94a3b8")),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(atk_table)
        story.append(Spacer(1, 12))

        # 5. Features, Traits & Spell Grimoire
        spells = char_data.get("spells", [])
        if spells:
            story.append(Paragraph(f"Spell Grimoire ({len(spells)} Prepared Spells)", self.section_header))
            spell_rows = [
                [
                    Paragraph("<b>SPELL NAME</b>", self.stat_label),
                    Paragraph("<b>LEVEL</b>", self.stat_label),
                    Paragraph("<b>SCHOOL</b>", self.stat_label),
                    Paragraph("<b>CASTING TIME</b>", self.stat_label),
                    Paragraph("<b>RANGE</b>", self.stat_label),
                ]
            ]
            for s in spells:
                lvl = "Cantrip" if s.get("level", 0) == 0 else f"Level {s.get('level', 1)}"
                spell_rows.append([
                    Paragraph(f"<b>{s.get('name', 'Spell')}</b>", self.body_small),
                    Paragraph(lvl, self.body_small),
                    Paragraph(s.get("school", "Evocation"), self.body_small),
                    Paragraph(s.get("casting_time", "1 action"), self.body_small),
                    Paragraph(s.get("range", "60 ft"), self.body_small),
                ])
            spell_table = Table(spell_rows, colWidths=[160, 80, 100, 100, 100])
            spell_table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#94a3b8")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            story.append(spell_table)

        doc.build(story)
        return buffer.getvalue()
