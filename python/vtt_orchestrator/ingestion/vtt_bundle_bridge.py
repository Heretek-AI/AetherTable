import json
import zipfile
import io
from typing import Dict, Any, List


class VttBundleBridge:
    """
    Format conversion importers and exporters for Foundry VTT, Roll20, and D&D Beyond into .vttbundle packages.
    """

    def export_to_vttbundle(self, session_metadata: Dict[str, Any], monsters: List[Dict[str, Any]], maps: List[Dict[str, Any]]) -> bytes:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            manifest = {
                "schema_version": "1.0.0",
                "campaign_name": session_metadata.get("name", "Campaign"),
                "monsters_count": len(monsters),
                "maps_count": len(maps),
            }
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
            zf.writestr("compendium/monsters.json", json.dumps(monsters, indent=2))
            zf.writestr("maps/grid_maps.json", json.dumps(maps, indent=2))

        buffer.seek(0)
        return buffer.read()

    def import_from_foundry_actor(self, foundry_json: Dict[str, Any]) -> Dict[str, Any]:
        """Converts Foundry VTT actor export format to Engine Compendium format."""
        system_data = foundry_json.get("system", {})
        attributes = system_data.get("attributes", {})
        hp_data = attributes.get("hp", {})

        return {
            "entity_id": f"monster_{foundry_json.get('name', 'actor').lower().replace(' ', '_')}",
            "entity_type": "monster",
            "name": foundry_json.get("name", "Unknown"),
            "base_ac": attributes.get("ac", {}).get("value", 10),
            "current_hp": hp_data.get("value", 10),
            "max_hp": hp_data.get("max", 10),
            "challenge_rating": system_data.get("details", {}).get("cr", 1.0),
        }
