import type { Skill } from "@/server/domain/types";
import type { TranslationKey } from "@/lib/i18n";

const builtInSkillKeys: Record<string, TranslationKey> = {
  Researcher: "skills.builtin.researcher",
  Writer: "skills.builtin.writer",
  Reviewer: "skills.builtin.reviewer"
};

export function skillLabel(
  t: (key: TranslationKey) => string,
  skill: Skill
): string {
  const key = skill.builtIn ? builtInSkillKeys[skill.name] : undefined;
  return key ? t(key) : skill.name;
}
