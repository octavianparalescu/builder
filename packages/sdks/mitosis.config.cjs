const traverse = require('traverse');
const seedrandom = require('seedrandom');
const rng = seedrandom('vue-sdk-seed');

/**
 * @typedef {import('@builder.io/mitosis')} Mitosis
 * @typedef {import('@builder.io/mitosis').MitosisNode} MitosisNode
 * @typedef {import('@builder.io/mitosis').StateValue} StateValue
 * @typedef {import('@builder.io/mitosis').MitosisConfig} MitosisConfig
 * @typedef {import('@builder.io/mitosis').MitosisPlugin} Plugin
 * @typedef {import('@builder.io/mitosis').OnMountHook} OnMountHook
 */

const getSeededId = () => {
  const rngVal = rng();
  return Number(String(rngVal).split('.')[1]).toString(36);
};

/**
 * @param {any} x
 * @returns {x is MitosisNode}
 */
const isMitosisNode = (x) => x && x['@type'] === '@builder.io/mitosis/node';

/**
 * @param {string} string
 */
const kebabCase = (string) =>
  string.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2').toLowerCase();

/**
 * @type {MitosisConfig['getTargetPath']}
 */
const getTargetPath = ({ target }) => {
  switch (target) {
    case 'rsc':
      return 'nextjs';
    default:
      return kebabCase(target);
  }
};

/**
 * @type {Plugin}
 */
const SRCSET_PLUGIN = () => ({
  code: {
    pre: (code) => {
      // workaround until we resolve
      // https://github.com/BuilderIO/mitosis/issues/526
      return code.replace(/srcset=/g, 'srcSet=');
    },
  },
});

/**
 * @type {Plugin}
 */
const FETCHPRIORITY_CAMELCASE_PLUGIN = () => ({
  code: {
    pre: (code) => {
      return code.replace(/fetchpriority=/g, 'fetchPriority=');
    },
  },
});

/**
 * Replaces all uses of the native `Text` component with our own `BaseText` component that injects inherited CSS styles
 * to `Text`, mimicking CSS inheritance.
 * @type {Plugin}
 */
const BASE_TEXT_PLUGIN = () => ({
  code: {
    pre: (code) => {
      if (code.includes('BaseText')) {
        return `
import BaseText from '../../blocks/BaseText';
${code}
`;
      }

      if (code.includes('<Text>') && !code.includes('InlinedStyles')) {
        const importStatement = `import BaseText from '../../blocks/BaseText';`;
        // we put the import statement after the first line so the `use client` comment stays at the top.
        // probably doesn't matter but just in case
        const [firstLine, ...restOfCode] = code.split('\n');
        return `
${firstLine}
${importStatement}
${restOfCode.join('\n').replace(/<(\/?)Text(.*?)>/g, '<$1BaseText$2>')}
`;
      }
      return code;
    },
  },
});

const REMOVE_MAGIC_PLUGIN = () => ({
  json: {
    post: (json) => {
      traverse(json).forEach(function (item) {
        if (!isMitosisNode(item)) return;

        for (const [key, _value] of Object.entries(item.properties)) {
          if (key === 'MAGIC') {
            delete item.properties[key];
          }
        }
      });

      return json;
    },
  },
});

const REMOVE_SET_CONTEXT_PLUGIN_FOR_FORM = () => ({
  code: {
    post: (code) => {
      return code.replace(
        `props.setBuilderContext((PREVIOUS_VALUE) => ({
        ...PREVIOUS_VALUE,
        rootState: combinedState,
      }));`,
        'props.builderContext.rootState = combinedState;'
      );
    },
  },
});

const target = process.argv
  .find((arg) => arg.startsWith('--target='))
  ?.split('=')[1];

const targets = target
  ? [target]
  : [
      'reactNative',
      'rsc',
      'vue',
      'solid',
      'svelte',
      'react',
      'qwik',
      'angular',
    ];

/**
 * @type {Plugin}
 */
const ADD_IS_STRICT_STYLE_MODE_TO_CONTEXT_PLUGIN = () => ({
  json: {
    pre: (json) => {
      if (json.name !== 'ContentComponent') return json;

      json.state.builderContextSignal.code =
        json.state.builderContextSignal.code.replace(
          /^\s*{/,
          '{strictStyleMode: props.strictStyleMode,'
        );

      return json;
    },
  },
});

/**
 * @type {Plugin}
 */
const MEMOIZING_BLOCKS_COMPONENT_PLUGIN = () => ({
  json: {
    post: (json) => {
      if (json.name === 'Block') {
        json.imports.push({
          imports: { memo: 'memo' },
          path: 'react',
        });
      }
      if (json.name === 'Blocks') {
        json.imports.push({
          imports: { memo: 'memo' },
          path: 'react',
        });

        json.hooks.init = {
          code: `
            ${json.hooks.init?.code || ''}
            const renderItem = React.useCallback(({ item }: { item: any }) => (
              <Block
                block={item}
                linkComponent={props.linkComponent}
                context={props.context || builderContext}
                registeredComponents={
                  props.registeredComponents || componentsContext?.registeredComponents
                }
              />
            ), [
              props.linkComponent,
              props.context,
              props.registeredComponents,
              builderContext,
              componentsContext?.registeredComponents
            ]);
          
            // Memoize keyExtractor
            const keyExtractor = React.useCallback((item: any) => 
              item.id.toString()
            , []);
          `,
        };

        if (json.children[0].children[1].children[0].name !== 'For') {
          throw new Error(
            'Blocks component must have a For block that will get converted to a FlatList'
          );
        }

        json.children[0].children[1].children[0] = {
          '@type': '@builder.io/mitosis/node',
          name: 'FlatList',
          meta: {},
          scope: {},
          properties: {},
          bindings: {
            data: { code: 'props.blocks', type: 'single' },
            renderItem: { code: 'renderItem', type: 'single' },
            keyExtractor: { code: 'keyExtractor', type: 'single' },
            removeClippedSubviews: { code: 'true', type: 'single' },
            maxToRenderPerBatch: { code: '10', type: 'single' },
            windowSize: { code: '5', type: 'single' },
            initialNumToRender: { code: '5', type: 'single' },
          },
          children: [],
        };
      }
      return json;
    },
  },
  code: {
    post: (code, json) => {
      if (json.name === 'Blocks') {
        return code.replace(
          'export default Blocks',
          'export default memo(Blocks)'
        );
      }
      if (json.name === 'Block') {
        return code.replace(
          'export default Block',
          'export default memo(Block)'
        );
      }
      return code;
    },
  },
});

/**
 * @type {Plugin}
 */
const INJECT_ENABLE_EDITOR_ON_EVENT_HOOKS_PLUGIN = () => ({
  json: {
    pre: (json) => {
      if (json.name !== 'EnableEditor') return;
      json.hooks.onMount.forEach((onMountHook) => {
        json.hooks.onEvent.forEach((eventHook) => {
          const isEditingHook =
            onMountHook.code.includes('INJECT_EDITING_HOOK_HERE') &&
            eventHook.eventName === 'initeditingbldr';

          if (isEditingHook) {
            onMountHook.code = onMountHook.code.replace(
              'INJECT_EDITING_HOOK_HERE',
              eventHook.code
            );
          }

          const isPreviewingHook =
            onMountHook.code.includes('INJECT_PREVIEWING_HOOK_HERE') &&
            eventHook.eventName === 'initpreviewingbldr';

          if (isPreviewingHook) {
            onMountHook.code = onMountHook.code.replace(
              'INJECT_PREVIEWING_HOOK_HERE',
              eventHook.code
            );
          }
        });

        onMountHook.code = onMountHook.code.replaceAll('elementRef', 'true');
      });

      json.hooks.onEvent = [];
    },
  },
});

/**
 *
 * Identifies all the bindings that are used to pass actions to our blocks.
 * Used by Vue/Svelte plugins to convert the bindings to the appropriate binding syntax.
 *
 * @param {import('@builder.io/mitosis').MitosisComponent} json
 * @param {MitosisNode} item
 */
const filterActionAttrBindings = (json, item) => {
  /**
   * Button component uses `filterAttrs` but calls `DynamicRender`.
   * Special case, we don't want to filter the `filterAttrs` calls even though they are there.
   */
  const isButton = json.name === 'Button';
  if (isButton) return [];

  return Object.entries(item.bindings).filter(([_key, value]) => {
    const blocksAttrs =
      value?.code.includes('filterAttrs') && value.code.includes('true');

    const dynamicRendererAttrs =
      json.name === 'DynamicRenderer' &&
      value?.code.includes('props.actionAttributes');

    return blocksAttrs || dynamicRendererAttrs;
  });
};

/**
 * @type {Plugin}
 */
const REMOVE_UNUSED_PROPS_HACK_PLUGIN = () => ({
  json: {
    post: (json) => {
      json.hooks.onMount = json.hooks.onMount.filter(
        (hook) =>
          !hook.code.includes('/** this is a hack to include unused props */')
      );
      return json;
    },
  },
});

// for fixing circular dependencies
/**
 * @type {Plugin}
 */
const ANGULAR_FIX_CIRCULAR_DEPENDENCIES_OF_COMPONENTS = () => ({
  json: {
    post: (json) => {
      if (json.name === 'ComponentRef' || json.name === 'RepeatedBlock') {
        json.imports.push({
          imports: { forwardRef: 'forwardRef' },
          path: '@angular/core',
        });
      }
      return json;
    },
  },
  code: {
    post: (code, json) => {
      if (json.name === 'ComponentRef' || json.name === 'RepeatedBlock') {
        code = code.replace(
          'imports: [CommonModule, Block]',
          'imports: [CommonModule, forwardRef(() => Block)]'
        );
      }
      return code;
    },
  },
});

/**
 * @type {Plugin}
 */
const ANGULAR_INJECT_UPDATE_VIEW_CODE = () => ({
  json: {
    post: (json) => {
      if (json.name === 'BlocksWrapper') {
        json.compileContext.angular.hooks.ngAfterContentChecked = {
          code: `if (this.shouldUpdate()) { this._updateView(); this.shouldUpdate.set(false); }`,
        };
      }
      return json;
    },
  },
});

const HAS_ATTRIBUTES_INPUT_METHOD = `hasAttributesInput(component): boolean {
  return !!reflectComponentType(component)?.inputs.find(input => input.propName === 'attributes');
}`;

const UPDATE_ATTRIBUTES_METHOD = `updateAttributes(
    el: HTMLElement,
    attributes: { [key: string]: any }
  ): void {
    Object.keys(attributes).forEach((attr) => {
      if (attr.startsWith("on")) {
        if (this._listenerFns.has(attr)) {
          this._listenerFns.get(attr)!();
        }
        this._listenerFns.set(
          attr,
          this.renderer.listen(
            el,
            attr.replace("on", "").toLowerCase(),
            attributes[attr]
          )
        );
      } else if (attr === 'class' && attributes[attr]) {
        const classes = attributes[attr].split(' ');
        classes.forEach((cls: string) =>
          this.renderer.addClass(el, cls.trim())
        );
      } else {
        this.renderer.setAttribute(el, attr.toLowerCase(), attributes[attr] ?? "");
      }
    });
  }`;

const ATTACH_ATTRIBUTES_METHOD = `if (!this.hasAttributesInput(this.Wrapper())) {
  const wrapperElement = this.wrapperTemplateRef()?.elementRef.nativeElement?.nextElementSibling;
  if (wrapperElement) {
    this.updateAttributes(wrapperElement, this.attributes());
  }
}`;

const FILTER_PROPS_METHOD = `filterPropsThatWrapperNeeds(allProps: any) {
    const definedPropNames = reflectComponentType(this.Wrapper()).inputs.map(prop => prop.propName);
    return definedPropNames.reduce((acc, propName) => {
      acc[propName] = allProps[propName];
      return acc;
    }, {});
  }`;

const ANGULAR_STATIC_COMPONENTS = new Set([
  'Awaiter',
  'Blocks',
  'BlocksWrapper',
  'BlockWrapper',
  'BuilderScripts',
  'ComponentRef',
  'EnableEditor',
  'ErrorBoundary',
  'LiveEdit',
]);

const ANGULAR_CHILDREN_TEMPLATE_SITES = {
  ComponentRef: {
    path: '../../../children-projector',
    children: 'builderChildrenIf(wrapperTemplate, blockChildrenToRender())',
  },
  InteractiveElement: {
    path: '../../children-projector',
    children: 'builderChildren()',
    legacyInPlace: true,
  },
  LiveEdit: {
    path: './children-projector',
    children: 'wrapperTemplate',
    projectsContent: true,
  },
  BlocksWrapper: {
    path: '../children-projector',
    children: 'blockswrapperTemplate',
    projectsContent: true,
  },
  EnableEditor: {
    path: '../../children-projector',
    children: 'contentwrapperTemplate',
    projectsContent: true,
  },
};

/**
 * Passes block children to dynamically created components as a `TemplateRef`
 * (`builderChildren` input, rendered with `ngTemplateOutlet`) instead of DOM
 * nodes projected through `ngComponentOutlet`'s `content`. Angular cannot
 * hydrate projected DOM nodes (NG0503); a component without a
 * `builderChildren` input still gets its children projected, inside
 * `builder-children-projector`, which skips hydration for that subtree, or
 * for the enclosing block or content when the children come from an
 * `<ng-content>` of the outer view. Only a component with a single
 * `<ng-content>` gets `builderChildren`; 0.26.2 fills only the first slot.
 * A registered component gets `builderChildren` only when its registration
 * sets `hydrateChildren` (Section and Fragment always do); otherwise its
 * children are projected as in 0.26.2 and it skips hydration.
 * Content hydrates only with `<builder-content [hydrate]="true">`, and never
 * when it has A/B variations (the browser picks the variant from a cookie, so
 * the server HTML may hold another variant) or in the Visual Editor or a
 * preview (the browser fetches other content than the server). Content that
 * does not hydrate renders its children exactly as before.
 *
 * @type {Plugin}
 */
const ANGULAR_HYDRATABLE_CHILDREN_PLUGIN = () => ({
  code: {
    post: (code, json) => {
      if (json.name === 'DynamicRenderer') return code;
      if (json.name === 'ContentVariants') {
        if (!code.includes('<content-component')) {
          throw new Error('ContentVariants: <content-component> not found');
        }
        const variantsClass = /export default class ContentVariants\b[^{]*\{/;
        if (!variantsClass.test(code)) {
          throw new Error('ContentVariants: class declaration not found');
        }
        const variantsConstructor =
          'constructor(public scriptsContext: BuilderScriptsContext) {}';
        if (!code.includes(variantsConstructor)) {
          throw new Error('ContentVariants: constructor not found');
        }
        code = code
          .replace(
            /<content-component\s/g,
            '<content-component [hydrate]="hydrate()" '
          )
          .replace(
            variantsClass,
            '$&\n  hydrate = input(false, { transform: builderBooleanAttribute });\n'
          )
          .replace(
            variantsConstructor,
            'constructor(public scriptsContext: BuilderScriptsContext) {\n    builderInject(BUILDER_HYDRATION, { optional: true })?.recordServerDecisions(builderInject(BuilderElementRef).nativeElement);\n  }'
          );
        return `import { booleanAttribute as builderBooleanAttribute, inject as builderInject, ElementRef as BuilderElementRef } from "@angular/core";\nimport { BUILDER_HYDRATION } from "../children-projector";\n${code}`;
      }
      if (json.name === 'ContentComponent') {
        const contentClass = /export default class ContentComponent\b[^{]*\{/;
        if (!contentClass.test(code)) {
          throw new Error('ContentComponent: class declaration not found');
        }
        const contentSelector = 'selector: "content-component",';
        if (!code.includes(contentSelector)) {
          throw new Error('ContentComponent: selector not found');
        }
        const contentConstructor = '  constructor() {\n';
        if (code.split(contentConstructor).length !== 2) {
          throw new Error('ContentComponent: constructor not found');
        }
        code = code
          .replace(
            contentSelector,
            `${contentSelector}\n  providers: [{ provide: BUILDER_HYDRATING, useFactory: () => builderInject(ContentComponent).builderHydrating }, { provide: BUILDER_REGISTERED_COMPONENTS, useFactory: () => builderInject(ContentComponent).registeredComponents }],`
          )
          .replace(
            contentClass,
            '$&\n  hydrate = input(false, { transform: builderBooleanAttribute });\n  private readonly builderHostRef = builderInject(BuilderElementRef);\n  private readonly builderIsServer = isPlatformServer(builderInject(BUILDER_PLATFORM_ID));\n  private readonly builderHydration = builderInject(BUILDER_HYDRATION, { optional: true });\n  private readonly builderParentHydrating = builderInject(BUILDER_HYDRATING, { optional: true, skipSelf: true });\n  readonly builderHydrating = createBuilderHydrating(() => isBuilderHydrating({ hydration: this.builderHydration, host: this.builderHostRef.nativeElement, parent: this.builderParentHydrating, nested: this.isNestedRender(), hydrate: this.hydrate(), ssrAbTest: this.isSsrAbTest(), content: this.content() }));\n  ngDoCheck() {\n    if (this.builderIsServer) this.builderHostRef.nativeElement.setAttribute("ngSkipHydration", "true");\n  }\n  ngAfterViewChecked() {\n    const host = this.builderHostRef.nativeElement;\n    const hydration = this.builderHydrating();\n    if (!hydration) {\n      if (!host.hasAttribute("ngSkipHydration")) host.setAttribute("ngSkipHydration", "true");\n    } else if (this.builderIsServer && !hydration.forced(host)) {\n      host.removeAttribute("ngSkipHydration");\n      if (!this.isNestedRender()) hydration.markUnhydratableMarkup(host);\n    }\n  }\n'
          )
          .replace(
            contentConstructor,
            '  constructor() {\n    if (this.builderIsServer) this.builderHostRef.nativeElement.setAttribute("ngSkipHydration", "true");\n'
          );
        return `import { booleanAttribute as builderBooleanAttribute, inject as builderInject, ElementRef as BuilderElementRef, PLATFORM_ID as BUILDER_PLATFORM_ID } from "@angular/core";\nimport { isPlatformServer } from "@angular/common";\nimport { BUILDER_HYDRATING, BUILDER_HYDRATION, BUILDER_REGISTERED_COMPONENTS, createBuilderHydrating, isBuilderHydrating } from "../children-projector";\n${code}`;
      }
      const upstream = code;
      code = ((code) => {
        const ngContent = /<ng-content><\/ng-content\s*>/;
        const slots = code.match(/<ng-content\b/g)?.length ?? 0;
        if (
          slots !== (code.match(/<ng-content><\/ng-content\s*>/g)?.length ?? 0)
        ) {
          throw new Error(`${json.name}: unsupported <ng-content>`);
        }
        const childrenOutlet =
          '<ng-container *ngTemplateOutlet="builderChildren()"></ng-container>';
        let takesChildren = false;
        if (json.name === 'InteractiveElement') {
          for (const close of ['</awaiter>', '</live-edit>']) {
            if (code.split(close).length !== 2) {
              throw new Error(`InteractiveElement: ${close} not found`);
            }
            code = code.replace(close, `${close}${childrenOutlet}`);
          }
          takesChildren = true;
        } else if (!ANGULAR_STATIC_COMPONENTS.has(json.name) && slots === 1) {
          code = code.replace(ngContent, `${childrenOutlet}$&`);
          takesChildren = true;
        }
        if (takesChildren) {
          const classDeclaration = new RegExp(
            `export default class ${json.name}\\b[^{]*\\{`
          );
          if (!classDeclaration.test(code)) {
            throw new Error(`${json.name}: class declaration not found`);
          }
          code = code.replace(
            classDeclaration,
            '$&\n  builderChildren = input<any>(undefined);\n'
          );
          if (
            !/import \{[^}]*\binput\b[^}]*\} from "@angular\/core"/.test(code)
          ) {
            code = `import { input } from "@angular/core";\n${code}`;
          }
        }

        const site = ANGULAR_CHILDREN_TEMPLATE_SITES[json.name];
        if (!site) {
          if (code.includes('content: myContent()')) {
            throw new Error(`${json.name}: unhandled dynamic component`);
          }
          return code;
        }

        const outlet =
          /<ng-container\s*\*ngComponentOutlet="\s*([^;"]+?);\s*inputs:\s*([^;"]+?);\s*content: myContent\(\);\s*"\s*>\s*<\/ng-container>/g;
        let outlets = 0;
        let legacy;
        code = code.replace(outlet, (_, component, inputs) => {
          outlets++;
          const children = site.children;
          const single = `<ng-container *ngComponentOutlet="builderOutlet.component(${component}, ${children}); inputs: builderOutlet.inputs(${component}, ${inputs}, ${children}); content: myContent();"></ng-container>`;
          if (!site.legacyInPlace) return single;
          const twin = `builderOutlet.twin(${component})`;
          legacy = `@else if (builderOutlet.legacy(${component}, ${children}, block())) {<ng-container [builderLegacyChildren]="${children}" [builderLegacyChildrenAt]="builderLegacyAt" #builderLegacy="builderLegacyChildren"></ng-container><ng-template [ngComponentOutlet]="${twin}" [ngComponentOutletInputs]="${inputs}" [ngComponentOutletContent]="builderLegacy.nodes"></ng-template><ng-container builderLegacyAnchor #builderLegacyAt="builderLegacyAnchor"></ng-container>} @else {${single}`;
          return 'BUILDER_LEGACY_OUTLET';
        });
        if (outlets !== 1) {
          throw new Error(
            `${json.name}: expected 1 dynamic outlet, found ${outlets}`
          );
        }
        if (legacy) {
          const legacyElse = /@else\s*\{\s*BUILDER_LEGACY_OUTLET/;
          if (!legacyElse.test(code)) {
            throw new Error(
              `${json.name}: outlet is not the only child of an @else`
            );
          }
          code = code.replace(legacyElse, () => legacy);
        }

        const updateView =
          /_updateView\(\) \{\s*this\.myContent\.set\(\[\s*this\.viewContainer\.createEmbeddedView\(this\.\w+\(\)\)\s*\.rootNodes,?\s*\]\);\s*\}/;
        if (!updateView.test(code)) {
          throw new Error(`${json.name}: _updateView not found`);
        }
        code = code.replace(updateView, (method) =>
          method.replace(
            '_updateView() {',
            '_updateView() {\n    if (this.builderHydrating()) return;'
          )
        );

        const viewContainerParam =
          /private viewContainer: ViewContainerRef,?\s*/;
        if (!viewContainerParam.test(code)) {
          throw new Error(`${json.name}: viewContainer injection not found`);
        }
        code = code.replace(viewContainerParam, '');

        if (site.legacyInPlace) {
          if (!code.includes('imports: [CommonModule')) {
            throw new Error(`${json.name}: component imports not found`);
          }
          code = code.replace(
            'imports: [CommonModule',
            'imports: [CommonModule, BuilderLegacyAnchor, BuilderLegacyChildren'
          );
        }
        const siteClass = new RegExp(
          `export default class ${json.name}\\b[^{]*\\{`
        );
        if (!siteClass.test(code)) {
          throw new Error(`${json.name}: class declaration not found`);
        }
        code = code.replace(
          siteClass,
          `$&\n  private readonly builderInjector = builderInject(BuilderInjector);\n  private get viewContainer() {\n    return this.builderInjector.get(ViewContainerRef);\n  }\n  protected readonly builderHydrating = injectBuilderHydrating();\n  protected readonly builderOutlet = createBuilderOutlet(this.builderHydrating${site.projectsContent ? ', true' : ''});\n${site.children.includes('builderChildrenIf') ? '  protected readonly builderChildrenIf = builderChildrenIf;\n' : ''}`
        );
        const imports = site.legacyInPlace
          ? 'BuilderLegacyAnchor, BuilderLegacyChildren, createBuilderOutlet, injectBuilderHydrating'
          : `${site.children.includes('builderChildrenIf') ? 'builderChildrenIf, ' : ''}createBuilderOutlet, injectBuilderHydrating`;
        return `import { inject as builderInject, Injector as BuilderInjector } from "@angular/core";\nimport { ${imports} } from "${site.path}";\n${code}`;
      })(code);
      if (ANGULAR_STATIC_COMPONENTS.has(json.name)) return code;
      const decoratorOf = (source) => {
        const decorators = source.match(
          new RegExp(
            `@Component\\(\\{\\n  selector: "[^"]+",(?:(?!@Component\\()[\\s\\S])*?\\n\\}\\)\\n(?=export default class ${json.name}\\b)`,
            'g'
          )
        );
        if (decorators?.length !== 1) {
          throw new Error(`${json.name}: expected 1 component decorator`);
        }
        return decorators[0];
      };
      const original = decoratorOf(upstream);
      const hydrating = decoratorOf(code);
      if (original === hydrating && json.name !== 'Image') return code;
      const imageSelector = 'selector: "image",';
      if (json.name === 'Image' && !hydrating.includes(imageSelector)) {
        throw new Error('Image: selector not found');
      }
      const twin =
        json.name === 'Image'
          ? hydrating.replace(imageSelector, 'selector: "builder-image",')
          : hydrating;
      const childrenInput = '\n  builderChildren = input<any>(undefined);\n';
      const ownsChildrenInput = code.includes(childrenInput);
      return `${code.replace(hydrating, () => original).replace(childrenInput, '\n')}\n${twin}export class Builder${json.name} extends ${json.name} {${ownsChildrenInput ? childrenInput : ''}}\n`;
    },
  },
});

/**
 * Opt-in `blockRenderer` input on `builder-content`: a component that receives
 * each top-level block of the page as `blockTemplate` (render it with
 * `ngTemplateOutlet`, context `$implicit: block`) plus the `block` itself, so the
 * app can wrap blocks, e.g. in `@defer (hydrate ...)`, without the SDK
 * depending on a newer Angular. Without it, blocks render as before. It is
 * used only when the content hydrates; a top-level block that holds a
 * component whose children are projected renders without it and skips
 * hydration.
 *
 * @type {Plugin}
 */
const ANGULAR_BLOCK_RENDERER_PLUGIN = () => ({
  code: {
    post: (code, json) => {
      const addInput = (name) => {
        const classDeclaration = new RegExp(
          `export default class ${name}\\b[^{]*\\{`
        );
        if (!classDeclaration.test(code)) {
          throw new Error(`${name}: class declaration not found`);
        }
        code = `import type { InputSignal as BuilderInputSignal } from "@angular/core";\nimport type { BuilderBlockRenderer } from "../children-projector";\n${code.replace(
          classDeclaration,
          '$&\n  blockRenderer: BuilderInputSignal<BuilderBlockRenderer> = input<BuilderBlockRenderer>(undefined);\n'
        )}`;
      };
      if (json.name === 'ContentVariants') {
        if (!code.includes('<content-component')) {
          throw new Error('ContentVariants: <content-component> not found');
        }
        code = code.replace(
          /<content-component\s/g,
          '<content-component [blockRenderer]="blockRenderer()" '
        );
        addInput('ContentVariants');
        return code;
      }
      if (json.name === 'ContentComponent') {
        if (!/<blocks\s/.test(code)) {
          throw new Error('ContentComponent: <blocks> not found');
        }
        code = code.replace(
          /<blocks\s/,
          '<blocks [blockRenderer]="isNestedRender() || !builderHydrating() ? undefined : blockRenderer()" '
        );
        addInput('ContentComponent');
        return code;
      }
      if (json.name !== 'Blocks') return code;
      const loop =
        /@if\(blocks\(\)\)\{\s*(@for \(block of blocks\(\);[\s\S]*?\$index\) \{)\s*(<block\s+\[block\]="block"[\s\S]*?><\/block>)\s*\}\s*\}/;
      if (!loop.test(code)) {
        throw new Error('Blocks: block loop not found');
      }
      code = code.replace(
        loop,
        (_, forBlock, block) =>
          `@if(blocks() && !(blockRenderer() && !parent())){ ${forBlock}${block}} } @else if (blocks()) {<ng-template #builderBlockTemplate let-block>${block}</ng-template>${forBlock}<ng-container *ngComponentOutlet="builderBlockRenderer(block); inputs: { blockTemplate: builderBlockTemplate, block: block }"></ng-container>} }`
      );
      addInput('Blocks');
      const blocksClass = /export default class Blocks\b[^{]*\{/;
      if (!blocksClass.test(code)) {
        throw new Error('Blocks: class declaration not found');
      }
      return `import { BuilderEagerBlock, injectBuilderHydrating } from "../children-projector";\n${code.replace(
        blocksClass,
        '$&\n  private readonly builderHydrating = injectBuilderHydrating();\n  protected builderBlockRenderer(block: unknown) {\n    return this.builderHydrating()?.eager(block, this.registeredComponents()) ? BuilderEagerBlock : this.blockRenderer();\n  }\n'
      )}`;
    },
  },
});

/**
 * @type {Plugin}
 */
const ANGULAR_NO_WRAP_INTERACTIVE_ELEMENT_PLUGIN = () => ({
  json: {
    pre: (json) => {
      if (json.name === 'InteractiveElement') {
        json.imports.push({
          imports: { reflectComponentType: 'reflectComponentType' },
          path: '@angular/core',
        });
        json.state['_listenerFns'] = {
          code: `new Map()`,
          type: 'single',
        };
        json.state['hasAttributesInput'] = {
          code: HAS_ATTRIBUTES_INPUT_METHOD,
          type: 'method',
        };
        json.state['filterPropsThatWrapperNeeds'] = {
          code: FILTER_PROPS_METHOD,
          type: 'method',
        };
        json.state['updateAttributes'] = {
          code: UPDATE_ATTRIBUTES_METHOD,
          type: 'method',
        };
        json.compileContext.angular.hooks.ngAfterViewInit = {
          code: ATTACH_ATTRIBUTES_METHOD,
        };

        if (!json.hooks.onUnMount) {
          json.hooks.onUnMount = {
            code: `
         for (const fn of this._listenerFns.values()) {
            fn();
          }
          `,
          };
        }
      }
      return json;
    },
  },
  code: {
    post: (code, json) => {
      if (json.name === 'InteractiveElement') {
        code = code.replace(
          'attributes = ',
          `private _listenerFns = new Map();
        attributes = `
        );
        code = code.replace(
          'attributes: this.attributes()',
          '...(this.hasAttributesInput(this.Wrapper()) && { attributes: this.attributes() })'
        );
        code = code.replace(
          '...this.targetWrapperProps()',
          '...(this.filterPropsThatWrapperNeeds(this.targetWrapperProps()))'
        );
      }
      return code;
    },
  },
});

/**
 * @type {Plugin}
 */
const QWIK_ONUPDATE_TO_USEVISIBLETASK = () => ({
  code: {
    post: (code, json) => {
      if (json.name === 'CustomCode') {
        code = code.replace('useTask$(', 'useVisibleTask$(');
      }
      return code;
    },
  },
});

/**
 * @type {Plugin}
 */
const QWIK_FORCE_RENDER_COUNT_FOR_RENDERING_CUSTOM_COMPONENT_DEFAULT_VALUE =
  () => ({
    json: {
      post: (json) => {
        if (json.name === 'InteractiveElement') {
          json.children[0].meta.else.meta.else.bindings['key'] = {
            code: "'wrapper-' + state.forceRenderCount",
            bindingType: 'expression',
            type: 'single',
          };
        }
      },
    },
  });

/**
 * @type {Plugin}
 */
const VUE_FIX_EXTRA_ATTRS_PLUGIN = () => ({
  json: {
    pre: (json) => {
      if (json.name === 'InteractiveElement') {
        delete json.children[0].meta.else.bindings.attributes;
      }

      return json;
    },
  },
});

/**
 * @type {Plugin}
 */
const REACT_NATIVE_IMPORT_COMPONENTS_PLUGIN = () => ({
  json: {
    post: (json) => {
      if (json.name === 'ContentComponent' || json.name === 'EnableEditor') {
        json.imports.push({
          imports: { ScrollView: 'ScrollView' },
          path: 'react-native',
        });
      }

      if (json.name === 'Block') {
        json.imports.push({
          imports: { View: 'View' },
          path: 'react-native',
        });
      }
    },
  },
});

/**
 * @type {MitosisConfig}
 */
module.exports = {
  files: 'src/**',
  exclude: ['src/**/*.test.ts'],
  targets,
  getTargetPath,
  commonOptions: {
    plugins: [REMOVE_MAGIC_PLUGIN],
  },
  options: {
    angular: {
      standalone: true,
      typescript: true,
      state: 'class-properties',
      api: 'signals',
      defaultExportComponents: true,
      plugins: [
        ANGULAR_FIX_CIRCULAR_DEPENDENCIES_OF_COMPONENTS,
        INJECT_ENABLE_EDITOR_ON_EVENT_HOOKS_PLUGIN,
        ANGULAR_INJECT_UPDATE_VIEW_CODE,
        ANGULAR_NO_WRAP_INTERACTIVE_ELEMENT_PLUGIN,
        ANGULAR_HYDRATABLE_CHILDREN_PLUGIN,
        ANGULAR_BLOCK_RENDERER_PLUGIN,
      ],
    },
    solid: {
      typescript: true,
      stylesType: 'style-tag',
      plugins: [
        INJECT_ENABLE_EDITOR_ON_EVENT_HOOKS_PLUGIN,
        REMOVE_SET_CONTEXT_PLUGIN_FOR_FORM,
      ],
    },
    vue: {
      typescript: true,
      namePrefix: (path) => (path.includes('/blocks/') ? 'builder' : ''),
      cssNamespace: getSeededId,
      plugins: [
        REMOVE_UNUSED_PROPS_HACK_PLUGIN,
        () => ({
          json: {
            // This plugin handles binding our actions to the `v-on:` Vue syntax:
            // - in our block components, the actions will come through `props.attributes` and need to be filtered
            // - in Block, the actions will be good to go from `state.actions`, and just need the `v-on:` prefix to be removed
            pre: (json) => {
              traverse(json).forEach(function (item) {
                if (!isMitosisNode(item)) return;

                const filterAttrKeys = filterActionAttrBindings(json, item);

                for (const [key, value] of filterAttrKeys) {
                  if (value) {
                    item.bindings[key] = {
                      ...value,
                      type: 'spread',
                      spreadType: 'event-handlers',
                    };
                  }
                }
              });
            },
          },
        }),
        VUE_FIX_EXTRA_ATTRS_PLUGIN,
      ],
      api: 'options',
      asyncComponentImports: false,
    },
    react: {
      typescript: true,
      plugins: [
        SRCSET_PLUGIN,
        FETCHPRIORITY_CAMELCASE_PLUGIN,
        INJECT_ENABLE_EDITOR_ON_EVENT_HOOKS_PLUGIN,
        REMOVE_SET_CONTEXT_PLUGIN_FOR_FORM,
      ],
      stylesType: 'style-tag',
      styleTagsPlacement: 'top',
    },
    rsc: {
      explicitImportFileExtension: true,
      typescript: true,
      plugins: [
        SRCSET_PLUGIN,
        FETCHPRIORITY_CAMELCASE_PLUGIN,
        REMOVE_SET_CONTEXT_PLUGIN_FOR_FORM,
        () => ({
          json: {
            pre: (json) => {
              if (json.name === 'Symbol') {
                delete json.state.setContent;

                json.state.contentToUse.code =
                  json.state.contentToUse?.code.replace('async () => ', '');
              } else if (json.name === 'EnableEditor') {
                json.context.set = {
                  '../../../context/builder.context.lite.js:default': {
                    name: 'builderContext',
                    ref: 'contextValue',
                  },
                };

                json.imports.push({
                  path: 'next/navigation',
                  imports: {
                    useRouter: 'useRouter',
                  },
                });
                json.hooks.init = {
                  code: `const router = useRouter();`,
                };
              }

              return json;
            },
          },
          code: {
            pre: (code) => {
              return code.replace('function Symbol(', 'async function Symbol(');
            },
          },
        }),
      ],
      stylesType: 'style-tag',
    },
    reactNative: {
      typescript: true,
      plugins: [
        SRCSET_PLUGIN,
        BASE_TEXT_PLUGIN,
        INJECT_ENABLE_EDITOR_ON_EVENT_HOOKS_PLUGIN,
        REMOVE_SET_CONTEXT_PLUGIN_FOR_FORM,
        ADD_IS_STRICT_STYLE_MODE_TO_CONTEXT_PLUGIN,
        MEMOIZING_BLOCKS_COMPONENT_PLUGIN,
        REACT_NATIVE_IMPORT_COMPONENTS_PLUGIN,
        () => ({
          json: {
            pre: (json) => {
              /**
               * We cannot set context in `ComponentRef` because it's a light component.
               * We only need to set the context for a React Native need: CSS-style inheritance for Text blocks.
               **/
              if (json.name === 'ComponentRef') {
                json.imports.push({
                  imports: {
                    BuilderContext: 'default',
                  },
                  path: '../../../../context/builder.context.lite',
                });
                json.context.set = {
                  '../../../../context/builder.context.lite:default': {
                    name: 'BuilderContext',
                    value: {
                      content: {
                        code: 'props.context.content',
                        type: 'property',
                      },
                      rootState: {
                        code: 'props.context.rootState',
                        type: 'property',
                      },
                      localState: {
                        code: 'props.context.localState',
                        type: 'property',
                      },
                      context: {
                        code: 'props.context.context',
                        type: 'property',
                      },
                      apiKey: {
                        code: 'props.context.apiKey',
                        type: 'property',
                      },
                      componentInfos: {
                        code: 'props.context.componentInfos',
                        type: 'property',
                      },
                      inheritedStyles: {
                        code: 'props.context.inheritedStyles',
                        type: 'property',
                      },
                      apiVersion: {
                        code: 'props.context.apiVersion',
                        type: 'property',
                      },
                    },
                  },
                };
              }

              /**
               * Fix types
               */
              if (json.name === 'CustomCode') {
                json.refs.elementRef.typeParameter = 'any';
              }

              /**
               * Fix component name as `Button` is imported from react-native
               */
              if (json.name === 'Button') {
                json.name = 'BuilderButton';
              }
            },
          },
        }),
        () => ({
          code: {
            post: (code) => {
              if (
                code.includes('BlocksWrapper') ||
                code.includes('EnableEditor')
              ) {
                /**
                 * Replaces `onPress` event handler with `onClick` for React Native
                 * such that visual editing "+Add Block" works on web target.
                 */
                code = code.replace('onPress', 'onClick');
              }
              return code;
            },
          },
        }),
      ],
    },
    qwik: {
      typescript: true,
      plugins: [
        FETCHPRIORITY_CAMELCASE_PLUGIN,
        /**
         * cleanup `onMount` hooks
         * - rmv unnecessary ones
         * - migrate necessary `onMount` hooks to `useOn('qvisible')` hooks
         */
        () => ({
          json: {
            pre: (json) => {
              if (['Symbol', 'ContentVariants'].includes(json.name)) {
                json.hooks.onMount = [];
                return;
              }

              if (['EnableEditor'].includes(json.name)) {
                json.hooks.onMount.forEach((hook, i) => {
                  if (hook.onSSR) return;

                  json.hooks.onMount.splice(i, 1);

                  json.hooks.onEvent.push({
                    code: hook.code.replaceAll('elementRef', 'element'),
                    eventArgName: 'event',
                    eventName: 'readystatechange',
                    isRoot: true,
                    refName: 'element',
                    elementArgName: 'element',
                  });
                });
              }
            },
            post: (json) => {
              if (json.name !== 'EnableEditor') return;
              json.imports.push({
                imports: { useOnDocument: 'useOnDocument' },
                path: '@builder.io/qwik',
              });
              return json;
            },
          },
          code: {
            post: (code, json) => {
              if (json.name === 'EnableEditor') {
                code = code.replaceAll(
                  `useOn(
    "readystatechange"`,
                  `useOnDocument(
    "readystatechange"`
                );
              }
              // BuilderScripts is optional; Qwik useContext throws without a provider unless given a default.
              return code.replaceAll(
                'useContext(BuilderScriptsContext)',
                'useContext(BuilderScriptsContext, { scriptsEmitted: false })'
              );
            },
          },
        }),
        QWIK_FORCE_RENDER_COUNT_FOR_RENDERING_CUSTOM_COMPONENT_DEFAULT_VALUE,
        QWIK_ONUPDATE_TO_USEVISIBLETASK,
      ],
    },
    svelte: {
      typescript: true,
      memoizeGetters: true,
      plugins: [
        /**
         * This plugin modifies `svelte:component` to elements to use the `svelte:element` syntax instead.
         * `svelte:component` is used for rendering dynamic Svelte components, and `svelte:element` is used for
         * rendering dynamic HTML elements. Mitosis can't know which one to use, and defaults to `svelte:component`,
         * so we have to override that.
         */
        () => ({
          json: {
            pre: (json) => {
              const tag =
                json.meta.useMetadata && json.meta.useMetadata.elementTag;

              if (tag) {
                const tagArr = Array.isArray(tag) ? tag : [tag];

                traverse(json).forEach(function (item) {
                  if (!isMitosisNode(item)) return;

                  if (tagArr.includes(item.name)) {
                    item.bindings.this = {
                      type: 'single',
                      ...item.bindings.this,
                      code: item.name,
                    };
                    item.name = 'svelte:element';
                  }
                });
              }
            },
          },
        }),
        () => ({
          json: {
            pre: (json) => {
              // This plugin handles binding our actions to the `use:` Svelte syntax:

              /**
               * `DynamicRenderer` will toggle between
               * <svelte:element> and <svelte:component> depending on the type of the block, while
               * handling empty HTML elements.
               */
              if (json.name === 'DynamicRenderer') {
                traverse(json).forEach(function (item) {
                  if (!isMitosisNode(item)) return;

                  if (!item.name.includes('TagName')) return;

                  item.bindings.this = {
                    type: 'single',
                    ...item.bindings.this,
                    code: item.name,
                  };
                  item.name = `svelte:${item.properties.MAGIC}`;
                });
              }

              // handle case where we have no wrapper element, in which case the actions are passed as attributes to our
              // builder blocks.
              traverse(json).forEach(function (item) {
                if (!isMitosisNode(item)) return;

                const filterAttrKeys = filterActionAttrBindings(json, item);

                for (const [key, value] of filterAttrKeys) {
                  if (value && item.name !== 'svelte:component') {
                    item.bindings['use:setAttrs'] = {
                      ...value,
                      type: 'single',
                    };

                    delete item.bindings[key];
                  }
                }
              });

              return json;
            },
          },
        }),
      ],
    },
  },
};
