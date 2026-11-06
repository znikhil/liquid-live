// Every mode the app offers. To add one, write a ModeDefinition and list it here.

import { assistant } from "./assistant.ts";
import type { ModeDefinition } from "./mode.ts";
import { tutor } from "./tutor.ts";

export const MODES: readonly ModeDefinition[] = [assistant, tutor];

export const findMode = (id: string) => MODES.find((m) => m.info.id === id);
