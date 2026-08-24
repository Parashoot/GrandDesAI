// Single dispatch point between "Grand Design core logic" (growth events, tags, proposals,
// the 0-100 meta-progression, session-note parsing -- all of scripts/*.js outside this folder)
// and "how does this game system actually store a mechanical ability" (this folder). Adding a
// new supported system means writing one more adapter module and one more entry in ADAPTERS;
// nothing outside this file needs to know which systems exist.
import { SUPPORTED_GAME_SYSTEMS } from "../constants.js";
import {
  buildCombinationItemSourcePf2e,
  buildEquipmentItemSourcePf2e,
  buildItemSourcePf2e,
  buildNpcActorSourcePf2e,
  buildTitleGrantItemSourcePf2e,
  buildTitleItemSourcePf2e,
  equivalentLabelPf2e,
  getCharacterLevelPf2e,
  SYSTEM_LABEL as PF2E_LABEL
} from "./pf2e-adapter.js";
import {
  buildCombinationItemSource5e,
  buildEquipmentItemSource5e,
  buildItemSource5e,
  buildNpcActorSource5e,
  buildTitleGrantItemSource5e,
  buildTitleItemSource5e,
  equivalentLabel5e,
  getCharacterLevel5e,
  SYSTEM_LABEL as DND5E_LABEL
} from "./dnd5e-adapter.js";

const ADAPTERS = {
  pf2e: {
    id: "pf2e",
    label: PF2E_LABEL,
    buildItemSource: buildItemSourcePf2e,
    getCharacterLevel: getCharacterLevelPf2e,
    equivalentLabel: equivalentLabelPf2e,
    buildNpcActorSource: buildNpcActorSourcePf2e,
    buildEquipmentItemSource: buildEquipmentItemSourcePf2e,
    buildTitleItemSource: buildTitleItemSourcePf2e,
    buildTitleGrantItemSource: buildTitleGrantItemSourcePf2e,
    buildCombinationItemSource: buildCombinationItemSourcePf2e
  },
  dnd5e: {
    id: "dnd5e",
    label: DND5E_LABEL,
    buildItemSource: buildItemSource5e,
    getCharacterLevel: getCharacterLevel5e,
    equivalentLabel: equivalentLabel5e,
    buildNpcActorSource: buildNpcActorSource5e,
    buildEquipmentItemSource: buildEquipmentItemSource5e,
    buildTitleItemSource: buildTitleItemSource5e,
    buildTitleGrantItemSource: buildTitleGrantItemSource5e,
    buildCombinationItemSource: buildCombinationItemSource5e
  }
};

export function isSupportedSystem(systemId) {
  return SUPPORTED_GAME_SYSTEMS.has(systemId);
}

export function supportedSystemIds() {
  return [...SUPPORTED_GAME_SYSTEMS];
}

export function getSystemAdapter(systemId) {
  const adapter = ADAPTERS[systemId];
  if (!adapter) {
    throw new Error(
      `Grand Design AI does not support the "${systemId}" game system yet. `
        + `Supported systems: ${supportedSystemIds().join(", ")}.`
    );
  }
  return adapter;
}
