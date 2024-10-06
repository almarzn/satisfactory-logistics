import Graph from 'graphology';
import voca from 'voca';
import { log } from '../../core/logger/log';
import { AllFactoryItemsMap, FactoryItem } from '../FactoryItem';
import {
  FactoryRecipe,
  getAllRecipesForItem,
  NotProducibleItems,
} from '../FactoryRecipe';
import {
  getWorldResourceMax,
  isWorldResource,
  WorldResourcesList,
} from '../WorldResources';
import { SolverRequest } from './store/SolverSlice';

const logger = log.getLogger('recipes:solver');
logger.setLevel('info');

export const encodeResource = (resource: string) =>
  voca
    .capitalize(resource.replace('Desc_', '').replace('_C', ''))
    .substring(0, 6);

type SolverNode =
  | { type: 'raw'; label: string; resource: FactoryItem; variable: string }
  | {
      type: 'raw_input';
      label: string;
      resource: FactoryItem;
      variable: string;
    }
  | {
      type: 'output';
      label: string;
      recipe: FactoryRecipe;
      recipeMainProductVariable: string;
      resource: FactoryItem;
      variable: string;
      byproductVariable: string;
    }
  | {
      type: 'byproduct';
      label: string;
      resource: FactoryItem;
      variable: string;
    }
  | {
      type: 'input';
      label: string;
      recipe: FactoryRecipe;
      recipeMainProductVariable: string;
      resource: FactoryItem;
      variable: string;
    }
  | {
      type: 'resource';
      label: string;
      resource: FactoryItem;
      variable: string;
    };

type SolverEdge = {
  type: 'link';
  resource: FactoryItem;
  source: FactoryRecipe | 'world';
  target: FactoryRecipe;
  variable: string;
  label: string;
};

export class SolverContext {
  // variables: SolverVariables;
  request: SolverRequest;
  processedRecipes = new Set<string>();
  allowedRecipes = new Set<string>();
  graph = new Graph<SolverNode, SolverEdge>();
  constraints: string[] = [];
  bounds: string[] = [];
  objective?: string;

  constructor(request: SolverRequest) {
    this.request = request;

    if (this.request.allowedRecipes) {
      this.allowedRecipes = new Set(this.request.allowedRecipes);
    }
  }

  private aliasIndex = 0;
  private aliases: Record<string, string> = {};
  private aliasesReverse: Record<string, string> = {};

  getWorldVars() {
    return this.graph
      .filterNodes((node, attributes) => attributes.type === 'raw')
      .map(node => this.graph.getNodeAttributes(node));
  }

  encodeVar(name: string) {
    if (!this.aliases[name]) {
      this.aliases[name] = `a${this.aliasIndex++}`;
      this.aliasesReverse[this.aliases[name]] = name;
    }
    return this.aliases[name];
  }

  decodeVar(varName: string) {
    return this.aliasesReverse[varName];
  }

  pretty(problem: string) {
    return problem.replace(
      /([a-z][\w]+)/g,
      (substring, rawVariable: string) => {
        const variable = rawVariable.startsWith('a')
          ? this.decodeVar(rawVariable)
          : rawVariable;

        if (this.graph.hasNode(variable)) {
          const node = this.graph.getNodeAttributes(variable);
          return '[' + node.label + ']';
        }
        if (this.graph.hasEdge(variable)) {
          const edge = this.graph.getEdgeAttributes(variable);
          return '[' + edge.label + ']';
        }

        return variable;
      },
    );
  }

  isRecipeAllowed(recipe: string) {
    if (this.allowedRecipes.size === 0) return true;
    return this.allowedRecipes.has(recipe);
  }

  formulateProblem() {
    if (!this.objective) {
      throw new Error('Objective not set');
    }

    const problem = [
      `MINIMIZE`, // TODO make configurable
      this.objective,
      `SUBJECT TO`,
      ...this.constraints,
      `BOUNDS`,
      ...WorldResourcesList.map(
        r =>
          `0 <= r${AllFactoryItemsMap[r].index} <= ${getWorldResourceMax(r)}`,
      ),
      ...this.bounds,
      `END`,
    ].join('\n');
    logger.log('Problem:\n', problem);
    return problem;
  }
}

export function consolidateProductionConstraints(ctx: SolverContext) {
  const resourceNodes = ctx.graph.filterNodes(
    (node, attributes) => attributes.type === 'resource',
  );
  // Resource nodes mixing recipe outputs to all ingredients
  for (const nodeName of resourceNodes) {
    const node = ctx.graph.getNodeAttributes(nodeName);
    const producers = ctx.graph.inboundNeighbors(nodeName);
    const consumers = ctx.graph.outboundNeighbors(nodeName);

    if (producers.length > 0) {
      ctx.constraints.push(
        `${producers.join(' + ')} - p${node.resource.index} = 0`,
      );
    }

    // Even if there are no consumers, we still need to add the constraint
    // to handle output (byproduct) resources
    ctx.constraints.push(
      `p${node.resource.index} ${consumers.length > 0 ? ' - ' + consumers.join(' - ') : ''} - b${node.resource.index} = 0`,
    );

    for (const inboundVar of producers) {
      const inbound = ctx.graph.getNodeAttributes(inboundVar);
      if (
        inbound.type !== 'output' &&
        inbound.type !== 'raw' &&
        inbound.type !== 'raw_input'
      ) {
        logger.error('Invalid inbound node type', inbound, node);
        throw new Error('Invalid inbound node type');
      }

      for (const outboundVar of consumers) {
        const outbound = ctx.graph.getNodeAttributes(outboundVar);
        if (outbound.type !== 'input') {
          logger.error('Invalid outbound node type', outbound, node);
          throw new Error('Invalid outbound node type');
        }
        const [edge, inserted] = ctx.graph.mergeEdgeWithKey(
          ctx.encodeVar(`l_${inboundVar}_${outboundVar}`),
          inboundVar,
          outboundVar,
          {
            type: 'link',
            resource: node.resource,
            source: inbound.type === 'output' ? inbound.recipe : 'world',
            target: outbound.recipe,
            variable: ctx.encodeVar(`l_${inboundVar}_${outboundVar}`),
            label: `Link: ${inbound.label} -> ${outbound.label}`,
          },
        );
      }
    }

    // From producer P to ingredients I1, I2, I3
    for (const producerVar of producers) {
      const producer = ctx.graph.getNodeAttributes(producerVar);

      const byproductVar =
        producer.type === 'output' ? producer.byproductVariable : null;

      ctx.constraints.push(
        `${producerVar} ${consumers.length === 0 ? '' : ' - ' + consumers.map(consumerVar => ctx.encodeVar(`l_${producerVar}_${consumerVar}`)).join(' - ')} ${byproductVar ? `- ${byproductVar}` : ''} = 0`,
      );
    }

    // From producers P1, P2, P3 to consumer C
    for (const consumerVar of consumers) {
      if (producers.length === 0) continue;
      const consumer = ctx.graph.getNodeAttributes(consumerVar);
      ctx.constraints.push(
        `${consumerVar} - ${producers.map(producerVar => ctx.encodeVar(`l_${producerVar}_${consumerVar}`)).join(' - ')} = 0`,
      );
    }
  }

  // Byproducts
  const byproductNodes = ctx.graph.filterNodes(
    (node, attributes) => attributes.type === 'byproduct',
  );
  for (const nodeName of byproductNodes) {
    const node = ctx.graph.getNodeAttributes(nodeName);
    // Es. `b${productItem.index}r${recipe.index}`
    const byproductEdges = ctx.graph.inboundEdges(nodeName);

    if (byproductEdges.length > 0) {
      ctx.constraints.push(
        `${node.variable} - ${byproductEdges.join(' - ')} = 0`,
      );
    }
  }
}

export function avoidUnproducibleResources(ctx: SolverContext) {
  NotProducibleItems.forEach(resource => {
    ctx.bounds.push(`p${AllFactoryItemsMap[resource].index} = 0`);
  });
}

function setGraphResource(ctx: SolverContext, resource: string) {
  ctx.graph.mergeNode(resource, {
    type: 'resource',
    label: resource,
    resource: AllFactoryItemsMap[resource],
    variable: resource,
  });
}

function setGraphByproduct(ctx: SolverContext, resource: string) {
  const item = AllFactoryItemsMap[resource];
  ctx.graph.mergeNode(`b${item.index}`, {
    type: 'byproduct',
    label: `Byproduct: ${item.displayName}`,
    resource: item,
    variable: `b${item.index}`,
  });
}

export function addInputResourceConstraints(
  ctx: SolverContext,
  resource: string,
  amount?: number,
) {
  setGraphResource(ctx, resource);
  const resourceItem = AllFactoryItemsMap[resource];
  const rawVar = `r${resourceItem.index}`;
  ctx.graph.mergeNode(rawVar, {
    type: 'raw_input',
    label: resource,
    resource: resourceItem,
    variable: rawVar,
  });
  ctx.graph.mergeEdge(rawVar, resource);
  ctx.constraints.push(`${rawVar} = ${amount ?? 0}`);
}

export function computeProductionConstraints(
  ctx: SolverContext,
  resource: string,
  amount?: number,
) {
  logger.debug('Processing recipes for: ', resource);

  const resourceItem = AllFactoryItemsMap[resource];
  const recipes = getAllRecipesForItem(resource);
  const rawVar = `r${resourceItem.index}`;
  if (isWorldResource(resource) && !ctx.graph.hasNode(rawVar)) {
    logger.debug('Adding raw resource:', resource);
    setGraphResource(ctx, resource);
    ctx.graph.mergeNode(rawVar, {
      type: 'raw',
      label: resource,
      resource: resourceItem,
      variable: rawVar,
    });
    ctx.graph.mergeEdge(rawVar, resource);
  }

  if (amount) {
    ctx.constraints.push(`b${resourceItem.index} = ${amount}`);
  }

  for (const recipe of recipes) {
    if (!ctx.isRecipeAllowed(recipe.id)) continue;
    if (ctx.processedRecipes.has(recipe.id)) continue;
    ctx.processedRecipes.add(recipe.id);
    const mainProductItem = AllFactoryItemsMap[recipe.products[0].resource];
    const mainProductVar = `p${mainProductItem.index}r${recipe.index}`;
    const mainProductAmount = (recipe.products[0].amount * 60) / recipe.time;
    logger.debug(' Processing recipe:', recipe.name, { mainProductItem, recipe }); // prettier-ignore

    for (const ingredient of recipe.ingredients) {
      // logger.debug('  Processing ingredient:', ingredient.resource);
      const ingredientItem = AllFactoryItemsMap[ingredient.resource];
      const recipeIngredientVar = `i${ingredientItem.index}r${recipe.index}`;
      setGraphResource(ctx, ingredient.resource);
      ctx.graph.addNode(recipeIngredientVar, {
        type: 'input',
        label: `Ingredient: ${ingredientItem.displayName} (${recipe.name})`,
        recipe,
        resource: ingredientItem,
        variable: recipeIngredientVar,
        recipeMainProductVariable: mainProductVar,
      });
      ctx.graph.mergeEdge(ingredient.resource, recipeIngredientVar);
      ctx.graph.mergeEdge(recipeIngredientVar, mainProductVar);
    }

    for (const product of recipe.products) {
      // logger.debug('  Processing product:', product.resource);
      const isMain = product.resource === recipe.products[0].resource;

      const productItem = AllFactoryItemsMap[product.resource];
      const recipeProductVar = `p${productItem.index}r${recipe.index}`;
      const recipeByproductVar = `b${productItem.index}r${recipe.index}`;
      setGraphResource(ctx, product.resource);
      ctx.graph.mergeNode(recipeProductVar, {
        type: 'output',
        label: `Product: ${productItem.displayName} (${recipe.name})`,
        recipe,
        resource: productItem,
        variable: recipeProductVar,
        recipeMainProductVariable: mainProductVar,
        byproductVariable: recipeByproductVar,
      });
      ctx.graph.mergeEdge(recipeProductVar, product.resource);
      const productAmount = (product.amount * 60) / recipe.time;

      // Byproduct
      setGraphByproduct(ctx, product.resource);
      ctx.graph.mergeEdgeWithKey(
        recipeByproductVar,
        recipeProductVar,
        `b${productItem.index}`,
      );

      if (!isMain) {
        ctx.graph.mergeEdge(mainProductVar, recipeProductVar); // Debug

        const factor = mainProductAmount / productAmount;
        ctx.constraints.push(
          `${factor} ${recipeProductVar} - ${mainProductVar} = 0`,
        );
        // logger.debug(
        //   '  Adding constraint:',
        //   `${factor} ${recipeProductVar} - ${mainProductVar} = 0`,
        // );
      }

      for (const ingredient of recipe.ingredients) {
        const ingredientItem = AllFactoryItemsMap[ingredient.resource];
        const recipeIngredientVar = `i${ingredientItem.index}r${recipe.index}`;
        const ingredientAmount = (ingredient.amount * 60) / recipe.time;
        const factor = productAmount / ingredientAmount;

        ctx.constraints.push(
          `${factor} ${recipeIngredientVar} - ${recipeProductVar} = 0`,
        );

        computeProductionConstraints(ctx, ingredient.resource);
      }
    }
  }
}
