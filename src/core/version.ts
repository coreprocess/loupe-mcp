/**
 * Release tags are the only source of truth for versions (PROJECT.md). The release pipeline
 * builds the tag's version into the image as LOUPE_VERSION; anything else reports `dev`.
 */
export const VERSION = process.env.LOUPE_VERSION ?? 'dev';
