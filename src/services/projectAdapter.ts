import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';
import type { CatalogData } from '../types/catalog';
import type { DisplayDomain, ExistingModelPreview } from '../types/display';
import type { UnifiedDomain } from '../types/semantic';
import type { ProjectProvider } from '../types/project';
import type { DomainService } from './domainService';
import type { ManifestService } from './manifestService';
import type { YmlParserService } from './ymlParserService';
import type { CatalogService } from './catalogService';

/** Transitional import shapes keep the existing editor and dbt behavior intact. */
export interface ProjectMetadata {
  manifest: ManifestData;
  declarations: YmlData;
  catalog?: CatalogData;
}

export interface ProjectAdapter {
  readonly provider: ProjectProvider;
  load(): Promise<ProjectMetadata>;
  invalidate(): void;
  buildPhysical(domain: UnifiedDomain, data: ProjectMetadata): DisplayDomain;
  existingModels?(domainNames: Set<string>, modelFolder?: string): ExistingModelPreview[];
}

export class DbtProjectAdapter implements ProjectAdapter {
  readonly provider = 'dbt' as const;
  constructor(private root: string, private domains: DomainService,
    private manifest: ManifestService, private declarations: YmlParserService, private catalog: CatalogService) {}
  async load(): Promise<ProjectMetadata> {
    const [manifest, declarations, catalog] = await Promise.all([
      this.manifest.loadManifest(this.root), this.declarations.loadYmlData(this.root), this.catalog.loadCatalog(this.root),
    ]);
    return { manifest, declarations, catalog };
  }
  invalidate(): void { this.manifest.invalidate(); this.declarations.invalidate(); this.catalog.invalidate(); }
  buildPhysical(domain: UnifiedDomain, data: ProjectMetadata): DisplayDomain {
    return this.domains.buildPhysicalDomain(domain, data.declarations, data.manifest, data.catalog);
  }
}
