export const artifactTypes = ["text", "markdown", "json"] as const;

export type ArtifactType = (typeof artifactTypes)[number];

export function isArtifactType(value: unknown): value is ArtifactType {
  return (
    typeof value === "string" &&
    artifactTypes.includes(value as ArtifactType)
  );
}
