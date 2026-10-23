import { InMemoryFileSystemHost, Project, ts } from "ts-morph";
import { analyze, type AnalysisResult, type Confidence } from "retrysafe/core";

export interface AnalyzeRequest {
  files: Record<string, string>;
  options?: { minConfidence?: Confidence; maxCallDepth?: number; serverActions?: boolean };
}

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function analyzeFiles(req: AnalyzeRequest): AnalysisResult {
  const fs = new InMemoryFileSystemHost();
  for (const [file, text] of Object.entries(req.files)) fs.writeFileSync(`/${file}`, text);

  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
  };
  let project: Project;
  if (req.files["tsconfig.json"]) {
    project = new Project({ fileSystem: fs, tsConfigFilePath: "/tsconfig.json", compilerOptions: { allowJs: true } });
    if (project.getSourceFiles().filter((s) => !s.isDeclarationFile()).length === 0) {
      project.addSourceFilesAtPaths(Object.keys(req.files).filter((f) => SOURCE.test(f)).map((f) => `/${f}`));
    }
  } else {
    project = new Project({ fileSystem: fs, compilerOptions });
    project.addSourceFilesAtPaths(Object.keys(req.files).filter((f) => SOURCE.test(f)).map((f) => `/${f}`));
  }

  return analyze({
    project,
    root: "/",
    minConfidence: req.options?.minConfidence,
    maxCallDepth: req.options?.maxCallDepth,
    handlers: req.options?.serverActions ? { serverActions: true } : undefined,
  });
}
