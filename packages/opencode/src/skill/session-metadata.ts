import { Effect, Layer, Context, Schema } from "effect"
import { Storage } from "@/storage/storage"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "session-metadata", tag: "dynamic-skills" })

// ---------------------------------------------------------------------------
// Skill.Info schema (inline to avoid circular import with @/skill)
// ---------------------------------------------------------------------------

const SkillInfoSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})

export type SkillInfo = Schema.Schema.Type<typeof SkillInfoSchema>

// ---------------------------------------------------------------------------
// Schema — JSON-serializable representation of dynamic skills metadata
// ---------------------------------------------------------------------------

/**
 * JSON-serializable form: Set becomes Array for storage.
 */
const StorageSchema = Schema.Struct({
  dynamicSkillsScanned: Schema.Array(Schema.String),
  dynamicSkillsRegistered: Schema.Record(Schema.String, SkillInfoSchema),
})

/**
 * In-memory type with Set for efficient lookups.
 */
export type DynamicSkillsMetadata = {
  dynamicSkillsScanned: Set<string>
  dynamicSkillsRegistered: Record<string, SkillInfo>
}

/**
 * Schema-backed class for in-memory metadata.
 * Uses Schema.Class for type-safe construction and validation.
 */
export class DynamicSkillsMetadataClass extends Schema.Class<DynamicSkillsMetadataClass>(
  "DynamicSkillsMetadata"
)({
  dynamicSkillsScanned: Schema.Array(Schema.String),
  dynamicSkillsRegistered: Schema.Record(Schema.String, SkillInfoSchema),
}) {}

/**
 * Encode in-memory metadata (with Set) to JSON-serializable form (with Array).
 */
export function encodeMetadata(metadata: DynamicSkillsMetadata): Schema.Schema.Type<typeof StorageSchema> {
  return {
    dynamicSkillsScanned: Array.from(metadata.dynamicSkillsScanned),
    dynamicSkillsRegistered: metadata.dynamicSkillsRegistered,
  }
}

/**
 * Decode JSON-serializable form (with Array) to in-memory metadata (with Set).
 */
export function decodeMetadata(data: Schema.Schema.Type<typeof StorageSchema>): DynamicSkillsMetadata {
  return {
    dynamicSkillsScanned: new Set(data.dynamicSkillsScanned),
    dynamicSkillsRegistered: data.dynamicSkillsRegistered,
  }
}

/**
 * Create empty metadata.
 */
export function emptyMetadata(): DynamicSkillsMetadata {
  return {
    dynamicSkillsScanned: new Set(),
    dynamicSkillsRegistered: {},
  }
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

function storageKey(sessionID: string): string[] {
  return ["session_dynamic_skills", sessionID]
}

// ---------------------------------------------------------------------------
// Service Interface
// ---------------------------------------------------------------------------

export interface Interface {
  /**
   * Get the full dynamic skills metadata for a session.
   * Returns empty metadata if not yet stored.
   */
  readonly getMetadata: (sessionID: string) => Effect.Effect<DynamicSkillsMetadata>

  /**
   * Add a scanned .agents/ directory realpath to dynamicSkillsScanned.
   * Idempotent: no-op if already present.
   */
  readonly addScannedDirectory: (sessionID: string, dirRealpath: string) => Effect.Effect<void>

  /**
   * Add a registered skill to dynamicSkillsRegistered.
   * Idempotent: no-op if skill name already exists.
   */
  readonly addRegisteredSkill: (sessionID: string, skill: SkillInfo) => Effect.Effect<void>

  /**
   * Check if a directory realpath has already been scanned.
   */
  readonly wasDirectoryScanned: (sessionID: string, dirRealpath: string) => Effect.Effect<boolean>

  /**
   * Get all registered skills for a session (for post-compaction restoration).
   */
  readonly getRegisteredSkills: (sessionID: string) => Effect.Effect<SkillInfo[]>

  /**
   * Clear all dynamic skills metadata for a session.
   */
  readonly clearMetadata: (sessionID: string) => Effect.Effect<void>
}

// Export individual methods for direct use (tests and consumers)
// These use Effect.sandbox to convert Service-not-found into a catchable error,
// allowing graceful degradation when SessionMetadata is not wired (e.g., in isolated tests).
export const getMetadata = (sessionID: string) =>
  Effect.flatMap(Service, (svc) => svc.getMetadata(sessionID))
    .pipe(
      Effect.sandbox,
      Effect.catch(() => Effect.succeed(emptyMetadata()).pipe(Effect.sandbox))
    )

export const addScannedDirectory = (sessionID: string, dirRealpath: string) =>
  Effect.flatMap(Service, (svc) => svc.addScannedDirectory(sessionID, dirRealpath))
    .pipe(
      Effect.sandbox,
      Effect.catch(() => Effect.void.pipe(Effect.sandbox))
    )

export const addRegisteredSkill = (sessionID: string, skill: SkillInfo) =>
  Effect.flatMap(Service, (svc) => svc.addRegisteredSkill(sessionID, skill))
    .pipe(
      Effect.sandbox,
      Effect.catch(() => Effect.void.pipe(Effect.sandbox))
    )

export const wasDirectoryScanned = (sessionID: string, dirRealpath: string) =>
  Effect.flatMap(Service, (svc) => svc.wasDirectoryScanned(sessionID, dirRealpath))
    .pipe(
      Effect.sandbox,
      Effect.catch(() => Effect.succeed(false).pipe(Effect.sandbox))
    )

export const getRegisteredSkills = (sessionID: string) =>
  Effect.flatMap(Service, (svc) => svc.getRegisteredSkills(sessionID))
    .pipe(
      Effect.sandbox,
      Effect.catch(() => Effect.succeed([] as SkillInfo[]).pipe(Effect.sandbox))
    )

export const clearMetadata = (sessionID: string) =>
  Effect.flatMap(Service, (svc) => svc.clearMetadata(sessionID))
    .pipe(
      Effect.sandbox,
      Effect.catch(() => Effect.void.pipe(Effect.sandbox))
    )

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMetadata") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service

    const getMetadata: Interface["getMetadata"] = Effect.fn("SessionMetadata.getMetadata")(function* (sessionID) {
      const data = yield* storage
        .read<Schema.Schema.Type<typeof StorageSchema>>(storageKey(sessionID))
        .pipe(
          Effect.catch(() => Effect.succeed(encodeMetadata(emptyMetadata())))
        )
      return decodeMetadata(data)
    })

    const addScannedDirectory: Interface["addScannedDirectory"] = Effect.fn("SessionMetadata.addScannedDirectory")(
      function* (sessionID, dirRealpath) {
        yield* storage.update<Schema.Schema.Type<typeof StorageSchema>>(
          storageKey(sessionID),
          (draft) => {
            if (!draft) {
              draft = encodeMetadata(emptyMetadata())
            }
            if (!draft.dynamicSkillsScanned.includes(dirRealpath)) {
              draft.dynamicSkillsScanned.push(dirRealpath)
            }
          },
        ).pipe(Effect.catch(() => {
          // First write: create with initial data
          const initial: Schema.Schema.Type<typeof StorageSchema> = {
            dynamicSkillsScanned: [dirRealpath],
            dynamicSkillsRegistered: {},
          }
          return storage.write(storageKey(sessionID), initial)
        }))
      },
    )

    const addRegisteredSkill: Interface["addRegisteredSkill"] = Effect.fn("SessionMetadata.addRegisteredSkill")(
      function* (sessionID, skill) {
        yield* storage.update<Schema.Schema.Type<typeof StorageSchema>>(
          storageKey(sessionID),
          (draft) => {
            if (!draft) {
              draft = encodeMetadata(emptyMetadata())
            }
            if (!draft.dynamicSkillsRegistered[skill.name]) {
              draft.dynamicSkillsRegistered[skill.name] = skill
            }
          },
        ).pipe(Effect.catch(() => {
          // First write: create with initial data
          const initial: Schema.Schema.Type<typeof StorageSchema> = {
            dynamicSkillsScanned: [],
            dynamicSkillsRegistered: { [skill.name]: skill },
          }
          return storage.write(storageKey(sessionID), initial)
        }))
      },
    )

    const wasDirectoryScanned: Interface["wasDirectoryScanned"] = Effect.fn("SessionMetadata.wasDirectoryScanned")(
      function* (sessionID, dirRealpath) {
        const metadata = yield* getMetadata(sessionID)
        return metadata.dynamicSkillsScanned.has(dirRealpath)
      },
    )

    const getRegisteredSkills: Interface["getRegisteredSkills"] = Effect.fn("SessionMetadata.getRegisteredSkills")(
      function* (sessionID) {
        const metadata = yield* getMetadata(sessionID)
        return Object.values(metadata.dynamicSkillsRegistered)
      },
    )

    const clearMetadata: Interface["clearMetadata"] = Effect.fn("SessionMetadata.clearMetadata")(function* (sessionID) {
      yield* storage.remove(storageKey(sessionID)).pipe(Effect.ignore)
    })

    return Service.of({
      getMetadata,
      addScannedDirectory,
      addRegisteredSkill,
      wasDirectoryScanned,
      getRegisteredSkills,
      clearMetadata,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Storage.defaultLayer))
