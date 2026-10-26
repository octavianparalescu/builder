import { CommonModule, isPlatformServer } from '@angular/common';
import type { TemplateRef, Type } from '@angular/core';
import {
  Component,
  Directive,
  ElementRef,
  InjectionToken,
  Injector,
  PLATFORM_ID,
  ViewChild,
  ViewContainerRef,
  inject,
  input,
  reflectComponentType,
  signal,
} from '@angular/core';
import { isEditing } from '../functions/is-editing';
import { isPreviewing } from '../functions/is-previewing';

const P_CLOSING_TAGS =
  'address,article,aside,blockquote,center,dd,details,dialog,dir,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,listing,main,menu,nav,ol,p,plaintext,pre,search,section,summary,table,ul,xmp';

const HEADING_TAGS = 'h1,h2,h3,h4,h5,h6';

const PARSER_SPECIAL_TAGS =
  'address,applet,area,article,aside,base,basefont,bgsound,blockquote,body,br,button,caption,center,col,colgroup,dd,details,dir,div,dl,dt,embed,fieldset,figcaption,figure,footer,form,frame,frameset,h1,h2,h3,h4,h5,h6,head,header,hgroup,hr,html,iframe,img,input,keygen,li,link,listing,main,marquee,menu,meta,nav,noembed,noframes,noscript,object,ol,p,param,plaintext,pre,script,section,select,source,style,summary,table,tbody,td,template,textarea,tfoot,th,thead,title,tr,track,ul,wbr,xmp';

const TABLE_CHILD_TAGS: Record<string, string[]> = {
  table: [
    'caption',
    'colgroup',
    'thead',
    'tbody',
    'tfoot',
    'script',
    'template',
    'style',
  ],
  thead: ['tr', 'script', 'template'],
  tbody: ['tr', 'script', 'template'],
  tfoot: ['tr', 'script', 'template'],
  tr: ['td', 'th', 'script', 'template'],
};

const SELECT_CHILD_TAGS = ['option', 'optgroup', 'hr', 'script', 'template'];

const closestTag = (el: Element | null, tagName: string) => {
  while (el && el.tagName.toUpperCase() !== tagName.toUpperCase()) {
    el = el.parentElement;
  }
  return el;
};

/**
 * The browser's HTML parser re-parents nodes it cannot nest (a `<p>` holding a
 * `<div>`, nested headings/links/buttons/forms, non-table elements inside table
 * parts), so server HTML with such nesting cannot hydrate. Skips hydration for the
 * closest block that contains the damage:
 * nothing is projected into a block from outside, so its subtree can be skipped.
 */
export const markUnhydratableMarkup = (root: Element) => {
  const parserSpecialTags = new Set(PARSER_SPECIAL_TAGS.split(','));
  const invalid: Element[] = [];
  for (const p of Array.from(root.querySelectorAll('p'))) {
    if (p.querySelector(P_CLOSING_TAGS)) invalid.push(p);
  }
  for (const heading of Array.from(root.querySelectorAll(HEADING_TAGS))) {
    if (heading.querySelector(HEADING_TAGS)) invalid.push(heading);
  }
  for (const inner of Array.from(
    root.querySelectorAll('a a, button button, form form')
  )) {
    const outer = closestTag(inner.parentElement, inner.tagName);
    if (outer) invalid.push(outer);
  }
  for (const select of Array.from(root.querySelectorAll('select'))) {
    if (
      Array.from(select.children).some(
        (child) => !SELECT_CHILD_TAGS.includes(child.tagName.toLowerCase())
      )
    ) {
      invalid.push(select);
    }
  }
  for (const part of Array.from(
    root.querySelectorAll(Object.keys(TABLE_CHILD_TAGS).join(','))
  )) {
    const allowed = TABLE_CHILD_TAGS[part.tagName.toLowerCase()];
    const table = closestTag(part, 'TABLE');
    if (
      table &&
      Array.from(part.children).some(
        (child) => !allowed.includes(child.tagName.toLowerCase())
      )
    ) {
      invalid.push(table);
    }
  }
  for (const el of invalid) {
    let boundary = el.parentElement;
    while (
      boundary &&
      boundary !== root &&
      !parserSpecialTags.has(boundary.tagName.toLowerCase())
    ) {
      boundary = boundary.parentElement;
    }
    const block =
      boundary && boundary !== root ? closestTag(boundary, 'BLOCK') : null;
    (block && root.contains(block) ? block : root).setAttribute(
      'ngSkipHydration',
      ''
    );
  }
};

type BuilderHydrationOutlet = ReturnType<typeof createHydratingOutlet>;

export interface BuilderHydration {
  createOutlet: (
    injector: Injector,
    projectsContent: boolean
  ) => BuilderHydrationOutlet;
  markUnhydratableMarkup: (root: Element) => void;
  recordServerDecisions: (host: Element) => void;
  serverDecision: (host: Element) => boolean | undefined;
  forced: (host: Element) => boolean;
}

export const BUILDER_HYDRATION = new InjectionToken<BuilderHydration>(
  'BUILDER_HYDRATION'
);

export type BuilderHydrating = () => BuilderHydration | null;

export type BuilderBlockRenderer = Type<unknown> | undefined;

export const BUILDER_HYDRATING = new InjectionToken<BuilderHydrating>(
  'BUILDER_HYDRATING'
);

export const createBuilderHydrating = (
  compute: BuilderHydrating
): BuilderHydrating => {
  let value: BuilderHydration | null | undefined;
  return () => (value === undefined ? (value = compute()) : value);
};

export const isBuilderHydrating = ({
  hydration,
  host,
  parent,
  nested,
  hydrate,
  ssrAbTest,
  content,
}: {
  hydration: BuilderHydration | null;
  host: Element;
  parent: BuilderHydrating | null;
  nested: boolean | undefined;
  hydrate: boolean;
  ssrAbTest: boolean | undefined;
  content: { variations?: object } | undefined;
}) => {
  if (!hydration) return null;
  const server = hydration.serverDecision(host);
  if (server !== undefined) return server ? hydration : null;
  return (parent ? parent() : !nested) &&
    (nested || hydrate) &&
    content &&
    !ssrAbTest &&
    !Object.keys(content.variations || {}).length &&
    !isEditing() &&
    !isPreviewing()
    ? hydration
    : null;
};

export const injectBuilderHydrating = (): BuilderHydrating =>
  inject(BUILDER_HYDRATING, { optional: true }) ?? (() => null);

const acceptsChildrenCache = new WeakMap<object, boolean>();

const acceptsChildren = (component: any): boolean => {
  if (!component) return false;
  let accepts = acceptsChildrenCache.get(component);
  if (accepts === undefined) {
    accepts = !!reflectComponentType(component)?.inputs.some(
      (componentInput) => componentInput.templateName === 'builderChildren'
    );
    acceptsChildrenCache.set(component, accepts);
  }
  return accepts;
};

export const builderChildrenIf = (
  children: TemplateRef<any> | undefined,
  items: unknown[] | undefined | null
) => (items?.length ? children : undefined);

const useProjector = (component: any, children: TemplateRef<any> | undefined) =>
  !!children && !!component && !acceptsChildren(component);

const createBuilderChildInputs = () => {
  let lastInputs: any;
  let lastChildren: TemplateRef<any> | undefined;
  let lastResult: any;
  return (
    component: any,
    inputs: any,
    children: TemplateRef<any> | undefined
  ) => {
    if (!children || !acceptsChildren(component)) return inputs;
    if (inputs !== lastInputs || children !== lastChildren) {
      lastInputs = inputs;
      lastChildren = children;
      lastResult = { ...inputs, builderChildren: children };
    }
    return lastResult;
  };
};

const skipBoundary = (host: Element, forced: WeakSet<Element>) => {
  let boundary = host.parentElement;
  while (
    boundary &&
    boundary.tagName !== 'BLOCK' &&
    boundary.tagName !== 'CONTENT-COMPONENT'
  ) {
    boundary = boundary.parentElement;
  }
  if (boundary && !forced.has(boundary)) {
    forced.add(boundary);
    boundary.setAttribute('ngSkipHydration', 'true');
  }
};

const createHydratingOutlet = (
  twins: Map<unknown, unknown>,
  projector: Type<unknown>,
  forced: WeakSet<Element>,
  injector: Injector,
  projectsContent: boolean
) => {
  const childInputs = createBuilderChildInputs();
  let last: { component: any; inputs: any; children: any } | undefined;
  const twin = (component: any) => twins.get(component) ?? component;
  const skipsContent =
    projectsContent && isPlatformServer(injector.get(PLATFORM_ID));
  return {
    twin,
    legacy: (component: any, children: TemplateRef<any> | undefined) =>
      useProjector(twin(component), children),
    component: (component: any, children: TemplateRef<any> | undefined) => {
      const target = twin(component);
      if (!useProjector(target, children)) return target;
      if (skipsContent) {
        skipBoundary(injector.get(ElementRef).nativeElement, forced);
      }
      return projector;
    },
    inputs: (
      component: any,
      inputs: any,
      children: TemplateRef<any> | undefined
    ) => {
      const target = twin(component);
      if (!useProjector(target, children)) {
        return childInputs(target, inputs, children);
      }
      if (
        last?.component !== target ||
        last.inputs !== inputs ||
        last.children !== children
      ) {
        last = { component: target, inputs, children };
      }
      return last;
    },
  };
};

export const createBuilderHydration = (
  twins: Map<unknown, unknown>,
  projector: Type<unknown>
): BuilderHydration => {
  const serverDecisions = new WeakMap<Element, boolean>();
  const forced = new WeakSet<Element>();
  return {
    createOutlet: (injector, projectsContent) =>
      createHydratingOutlet(
        twins,
        projector,
        forced,
        injector,
        projectsContent
      ),
    markUnhydratableMarkup,
    recordServerDecisions: (host) => {
      const editing = isEditing() || isPreviewing();
      for (const child of Array.from(host.children)) {
        if (child.tagName !== 'CONTENT-COMPONENT') continue;
        if (editing) {
          child.setAttribute('ngSkipHydration', 'true');
          child.removeAttribute('ngh');
        }
        serverDecisions.set(child, !child.hasAttribute('ngSkipHydration'));
      }
    },
    serverDecision: (host) => serverDecisions.get(host),
    forced: (host) => forced.has(host),
  };
};

export const createBuilderOutlet = (
  hydrating: BuilderHydrating,
  projectsContent = false
) => {
  const injector = inject(Injector);
  let outlet: BuilderHydrationOutlet | undefined;
  const hydratingOutlet = () => {
    const hydration = hydrating();
    return hydration
      ? (outlet ??= hydration.createOutlet(injector, projectsContent))
      : undefined;
  };
  return {
    twin: (component: any) => hydratingOutlet()?.twin(component) ?? component,
    legacy: (component: any, children: TemplateRef<any> | undefined) =>
      !!hydratingOutlet()?.legacy(component, children),
    component: (component: any, children: TemplateRef<any> | undefined) => {
      const target = hydratingOutlet();
      return target ? target.component(component, children) : component;
    },
    inputs: (
      component: any,
      inputs: any,
      children: TemplateRef<any> | undefined
    ) => {
      const target = hydratingOutlet();
      return target ? target.inputs(component, inputs, children) : inputs;
    },
  };
};

@Component({
  selector: 'builder-children-projector',
  standalone: true,
  imports: [CommonModule],
  host: { ngSkipHydration: 'true' },
  template: `<ng-container #childrenAnchor></ng-container
    ><ng-container
      *ngComponentOutlet="component(); inputs: inputs(); content: nodes()"
    ></ng-container>`,
  styles: [':host { display: contents; }'],
})
export default class BuilderChildrenProjector {
  component = input<any>(undefined);
  inputs = input<any>(undefined);
  children = input<TemplateRef<any> | undefined>(undefined);

  @ViewChild('childrenAnchor', { read: ViewContainerRef, static: true })
  childrenAnchor!: ViewContainerRef;

  nodes = signal<any[][] | undefined>(undefined);

  ngOnInit() {
    const children = this.children();
    if (children) {
      this.nodes.set([
        this.childrenAnchor.createEmbeddedView(children).rootNodes,
      ]);
    }
  }
}

@Directive({
  selector: '[builderLegacyAnchor]',
  standalone: true,
  exportAs: 'builderLegacyAnchor',
})
export class BuilderLegacyAnchor {
  readonly viewContainer = inject(ViewContainerRef);
}

/**
 * In-place variant of `builder-children-projector` for a component template
 * root: renders the children at `builderLegacyChildrenAt`, after the sibling
 * `ngComponentOutlet`, for projection into it (a component without
 * `<ng-content>` keeps them after itself, as 0.26.2 did), and on the server
 * marks the enclosing component host `ngSkipHydration`, so no wrapper element
 * is added around the target.
 */
@Directive({
  selector: '[builderLegacyChildren]',
  standalone: true,
  exportAs: 'builderLegacyChildren',
})
export class BuilderLegacyChildren {
  children = input<TemplateRef<any> | undefined>(undefined, {
    alias: 'builderLegacyChildren',
  });
  at = input.required<BuilderLegacyAnchor>({
    alias: 'builderLegacyChildrenAt',
  });
  nodes: any[][] | undefined;

  private readonly anchor = inject(ElementRef);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private rendered: TemplateRef<any> | undefined;

  ngOnChanges() {
    const children = this.children();
    if (children === this.rendered) return;
    this.rendered = children;
    const viewContainer = this.at().viewContainer;
    viewContainer.clear();
    this.nodes = children
      ? [viewContainer.createEmbeddedView(children).rootNodes]
      : undefined;
    if (this.isServer) {
      (this.anchor.nativeElement as Node).parentElement?.setAttribute(
        'ngSkipHydration',
        ''
      );
    }
  }
}
