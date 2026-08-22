"""
Campaign Archive Bundle Packager (.vttbundle)
Ported and synthesized from DSPaul/COMPASS satchel archive concepts.
Compresses and decompresses complete campaign states into standardized zip archives.
"""

import io
import json
import zipfile
from datetime import datetime, timezone
from typing import Dict, Any, Optional


class CampaignBundlePackager:
    BUNDLE_SPEC_VERSION = "1.0.0"

    def export_bundle(self, campaign_data: Dict[str, Any]) -> bytes:
        zip_buffer = io.BytesIO()

        manifest = {
            "title": campaign_data.get("title", "AetherTable Campaign"),
            "spec_version": self.BUNDLE_SPEC_VERSION,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "author": campaign_data.get("author", "AI Multi-Agent Director"),
            "ruleset": campaign_data.get("ruleset", "D&D 5e SRD + Homebrew"),
            "grid_dimensions": campaign_data.get("grid_dimensions", {"width": 16, "height": 12}),
            "token_count": len(campaign_data.get("tokens", [])),
            "noble_house_count": len(campaign_data.get("dynasties", {}).get("houses", [])),
            "lore_propositions_count": len(campaign_data.get("lore_graph", {}).get("edges", [])),
        }

        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            # 1. Manifest
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))

            # 2. Map Layout & Walls
            map_layout = {
                "walls": campaign_data.get("walls", []),
                "grid_width": campaign_data.get("grid_dimensions", {}).get("width", 16),
                "grid_height": campaign_data.get("grid_dimensions", {}).get("height", 12),
            }
            zf.writestr("map_layout.json", json.dumps(map_layout, indent=2))

            # 3. Tokens & Character Sheets
            zf.writestr("tokens.json", json.dumps(campaign_data.get("tokens", []), indent=2))

            # 4. Noble House Dynasty Trees
            zf.writestr("dynasties.json", json.dumps(campaign_data.get("dynasties", {}), indent=2))

            # 5. Epistemic Lore Graph
            zf.writestr("lore_graph.json", json.dumps(campaign_data.get("lore_graph", {}), indent=2))

            # 6. Loot & Room Dressing Tables
            zf.writestr("loot_tables.json", json.dumps(campaign_data.get("loot_tables", {}), indent=2))

        return zip_buffer.getvalue()

    def import_bundle(self, zip_bytes: bytes) -> Dict[str, Any]:
        zip_buffer = io.BytesIO(zip_bytes)
        campaign_data: Dict[str, Any] = {}

        with zipfile.ZipFile(zip_buffer, "r") as zf:
            file_list = zf.namelist()
            if "manifest.json" not in file_list:
                raise ValueError("Invalid .vttbundle: missing manifest.json")

            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            campaign_data["manifest"] = manifest

            if "map_layout.json" in file_list:
                campaign_data["map_layout"] = json.loads(zf.read("map_layout.json").decode("utf-8"))
            if "tokens.json" in file_list:
                campaign_data["tokens"] = json.loads(zf.read("tokens.json").decode("utf-8"))
            if "dynasties.json" in file_list:
                campaign_data["dynasties"] = json.loads(zf.read("dynasties.json").decode("utf-8"))
            if "lore_graph.json" in file_list:
                campaign_data["lore_graph"] = json.loads(zf.read("lore_graph.json").decode("utf-8"))
            if "loot_tables.json" in file_list:
                campaign_data["loot_tables"] = json.loads(zf.read("loot_tables.json").decode("utf-8"))

        return campaign_data


global_bundle_packager = CampaignBundlePackager()
