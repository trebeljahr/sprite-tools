import { boundedFile, sameOriginFile } from "../browser-files";
import { importCharacterZip, type CharacterSession } from "./browser";

export async function linkedCharacterProject(
  path: string,
  base: string,
  signal: AbortSignal,
): Promise<CharacterSession> {
  const projectUrl = sameOriginFile(path, base),
    bytes = await boundedFile(projectUrl, 64 * 1024 * 1024, signal);
  const session = await importCharacterZip(
    new File([new Uint8Array(bytes)], "character.zip", { type: "application/zip" }),
  );
  return { ...session, projectUrl };
}
