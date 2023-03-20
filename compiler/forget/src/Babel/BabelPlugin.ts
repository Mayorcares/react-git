/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/// <reference path="./plugin-syntax-jsx.d.ts" />

import type * as BabelCore from "@babel/core";
import jsx from "@babel/plugin-syntax-jsx";
import * as t from "@babel/types";
import invariant from "invariant";
import { compile } from "../CompilerPipeline";
import { parsePluginOptions, PluginOptions } from "./PluginOptions";

type BabelPluginPass = {
  opts: PluginOptions;
};

const testId = t.identifier("isForgetEnabled");

function hasUseForgetDirective(directives: t.Directive[]): boolean {
  for (const directive of directives) {
    if (directive.value.value === "use forget") {
      return true;
    }
  }
  return false;
}

/**
 * The React Forget Babel Plugin
 * @param {*} _babel
 * @returns
 */
export default function ReactForgetBabelPlugin(
  _babel: typeof BabelCore
): BabelCore.PluginObj {
  let hasForgetCompiledCode: boolean = false;

  const visitor = {
    FunctionDeclaration(
      fn: BabelCore.NodePath<t.FunctionDeclaration>,
      pass: BabelPluginPass
    ): void {
      if (pass.opts.enableOnlyOnUseForgetDirective) {
        if (!hasUseForgetDirective(fn.node.body.directives)) {
          return;
        }
      }

      if (fn.scope.getProgramParent() !== fn.scope.parent) {
        return;
      }

      hasForgetCompiledCode = true;
      const compiled = compile(fn, pass.opts.environment);

      if (pass.opts.gatingModule) {
        // Rename existing function
        invariant(fn.node.id, "FunctionDeclaration must have a name");
        const original = fn.node.id;
        fn.node.id = addSuffix(fn.node.id, "_uncompiled");

        // Rename and append compiled function
        invariant(compiled.id, "FunctionDeclaration must produce a name");
        compiled.id = addSuffix(compiled.id, "_forget");
        const compiledFn = fn.insertAfter(compiled)[0];
        compiledFn.skip();

        // Build and append gating test
        compiledFn.insertAfter(buildGatingTest(fn, compiled.id, original));
      } else {
        fn.replaceWith(compiled);
      }

      // We are generating a new FunctionDeclaration node, so we must skip over it or this
      // traversal will loop infinitely.
      fn.skip();
    },
  };

  return {
    name: "react-forget",
    inherits: jsx,
    visitor: {
      // Note: Babel does some "smart" merging of visitors across plugins, so even if A is inserted
      // prior to B, if A does not have a Program visitor and B does, B will run first. We always
      // want Forget to run true to source as possible.
      Program(path, pass): void {
        const options = parsePluginOptions(pass.opts);
        try {
          path.traverse(visitor, {
            ...pass,
            opts: { ...pass.opts, ...options },
          });

          if (options.gatingModule && hasForgetCompiledCode) {
            path.unshiftContainer(
              "body",
              buildImportForGatingModule(options.gatingModule)
            );
          }
        } catch (err) {
          if (options.logger && err) {
            options.logger.logEvent("err", err);
          }
          throw err;
        }
      },
    },
  };
}

function buildGatingTest(
  uncompiled: BabelCore.NodePath<t.FunctionDeclaration>,
  compiled: t.Identifier,
  original: t.Identifier
): t.Node | t.Node[] {
  const test = buildTest({
    uncompiled: uncompiled.node.id!,
    compiled,
    original,
  });

  // Re-export new declaration
  const parent = uncompiled.parentPath;
  if (t.isExportDefaultDeclaration(parent)) {
    // Re-add uncompiled function
    parent.replaceWith(uncompiled)[0].skip();

    // Add test and synthesize new export
    return [test, t.exportDefaultDeclaration(original)];
  } else if (t.isExportNamedDeclaration(parent)) {
    // Re-add uncompiled function
    parent.replaceWith(uncompiled)[0].skip();

    // Add and export test
    return t.exportNamedDeclaration(test);
  }

  // Just add the test, no need for re-export
  return test;
}

function addSuffix(id: t.Identifier, suffix: string): t.Identifier {
  return t.identifier(`${id.name}${suffix}`);
}

function buildTest(ids: {
  uncompiled: t.Identifier;
  compiled: t.Identifier;
  original: t.Identifier;
}): t.VariableDeclaration {
  return t.variableDeclaration("const", [
    t.variableDeclarator(
      ids.original,
      t.conditionalExpression(testId, ids.compiled, ids.uncompiled)
    ),
  ]);
}

function buildImportForGatingModule(gatingModule: string): t.ImportDeclaration {
  const importDefaultSpecifier = t.importDefaultSpecifier(testId);
  return t.importDeclaration(
    [importDefaultSpecifier],
    t.stringLiteral(gatingModule)
  );
}
