import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
export interface Project {
  id: string;
  root: string;
  revision: string;
}
/** Explicit project roots, confined to the operator's workspace. No ambient repository crawl. */
export class Projects {
  private projects: Project[] = [];
  private readonly root: string;
  private readonly file: string;
  constructor(file: string, workspace: string) {
    this.file = file;
    this.root = realpathSync(workspace);
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Project[];
      if (!Array.isArray(saved)) throw Error('invalid project registry');
      this.projects = saved.map((p) => this.validate(p));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private validate(p: Project): Project {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.id) ||
      typeof p.revision !== 'string' ||
      !p.revision ||
      p.revision.length > 256
    )
      throw Error('invalid project id or revision');
    const root = realpathSync(resolve(p.root)),
      part = relative(this.root, root);
    if (part === '..' || part.startsWith('../') || isAbsolute(part) || !statSync(root).isDirectory())
      throw Error('project root must be inside RUNNER_CWD');
    return { id: p.id, root, revision: p.revision };
  }
  list(): Project[] {
    return this.projects.map((p) => ({ ...p }));
  }
  get(id: string): Project {
    const p = this.projects.find((p) => p.id === id);
    if (!p) throw Error('unknown project');
    return this.validate(p);
  }
  put(input: Project): Project {
    const p = this.validate(input),
      existing = this.projects.find((q) => q.id === p.id);
    if (existing && existing.root !== p.root) throw Error('project roots are immutable; register a new project id');
    this.projects = [...this.projects.filter((q) => q.id !== p.id), p];
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.projects), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    return p;
  }
}
