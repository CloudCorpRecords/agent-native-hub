// Local store: plain JSON files under <workspace>/.anh/<collection>/<id>.json
// Simple and inspectable on purpose. No database in the MVP.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Collection = "passports" | "intents" | "workrooms" | "proofpacks" | "decisions" | "reputation" | "tokens" | "prsyncs" | "deliveries" | "vettings";

export class Store {
  readonly root: string;

  constructor(workspace: string) {
    this.root = join(workspace, ".anh");
  }

  private dir(collection: Collection): string {
    const d = join(this.root, collection);
    mkdirSync(d, { recursive: true });
    return d;
  }

  pathFor(collection: Collection, id: string): string {
    return join(this.dir(collection), `${id}.json`);
  }

  save<T extends { id: string }>(collection: Collection, obj: T): string {
    const p = this.pathFor(collection, obj.id);
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
    return p;
  }

  load<T>(collection: Collection, id: string): T | null {
    const p = join(this.root, collection, `${id}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  }

  loadFromFile<T>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  }

  list<T>(collection: Collection): T[] {
    const d = this.dir(collection);
    return readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as T);
  }
}
