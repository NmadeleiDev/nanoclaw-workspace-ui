import fs from 'node:fs';
import path from 'node:path';
import { selectGatewayAgentSkills } from './gateway-providers/index.js';

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
export function selectedSkillNames(
  containerConfig: Pick<import('./container-config.js').ContainerConfig, 'skills'>,
  sharedSkillsDir = path.join(process.cwd(), 'container', 'skills'),
): string[] {
  const available = fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  const selected = containerConfig.skills === 'all' ? available : containerConfig.skills;
  return selectGatewayAgentSkills(selected);
}
