import * as path from 'node:path';

import { LayerService } from '../../src/services/layerService.js';
import { LogicalModelService } from '../../src/services/logicalModelService.js';
import { DomainService } from '../../src/services/domainService.js';
import { SqlmeshProjectAdapter } from '../../src/services/sqlmeshAdapter.js';
import { DbtProjectAdapter, type ProjectAdapter } from '../../src/services/projectAdapter.js';
import { detectProjectProvider } from '../../src/services/projectDetection.js';
import { YmlParserService } from '../../src/services/ymlParserService.js';
import { CatalogService } from '../../src/services/catalogService.js';
import { readDbtProjectConfig } from '../../src/services/dbtProjectConfig.js';
import { ManifestService } from '../../src/services/manifestService.js';

export interface Services {
  projectPath: string;
  semanticDir: string;
  layerService: LayerService;
  logicalModelService: LogicalModelService;
  domainService: DomainService;
  manifestService: ManifestService;
  projectAdapter: ProjectAdapter;
}

const SEMANTIC_DIR = '.erd-studio';

export function resolveProjectPath(input: string, provider = 'auto'): string {
  const resolved = path.resolve(input);
  if (!detectProjectProvider(resolved, provider)) {
    throw new Error(
      `Not a dbt or SQLMesh project: ${resolved}. Pass its absolute root path.`,
    );
  }
  return resolved;
}

export function buildServices(projectPathInput: string, provider = 'auto'): Services {
  const projectPath = resolveProjectPath(projectPathInput, provider);
  const layerService = new LayerService(projectPath, SEMANTIC_DIR);
  const logicalModelService = new LogicalModelService(projectPath, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  domainService.setLogicalModelService(logicalModelService);
  const dbtConfig = readDbtProjectConfig(projectPath);
  const manifestService = new ManifestService({ dbtConfig });
  const projectAdapter = detectProjectProvider(projectPath, provider) === 'sqlmesh'
    ? new SqlmeshProjectAdapter(projectPath, SEMANTIC_DIR)
    : new DbtProjectAdapter(projectPath, domainService, manifestService, new YmlParserService({ dbtConfig }), new CatalogService({ dbtConfig }));
  return {
    projectPath,
    semanticDir: SEMANTIC_DIR,
    layerService,
    logicalModelService,
    domainService,
    manifestService,
    projectAdapter,
  };
}
