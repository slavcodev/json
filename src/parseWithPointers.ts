import { DiagnosticSeverity, IDiagnostic, IParserASTResult, IRange, JsonPath } from '@stoplight/types';
import { JSONVisitor, NodeType, ParseErrorCode, printParseErrorCode, visit } from 'jsonc-parser';
import { IJsonASTNode, IParseOptions, JsonParserResult } from './types';

export const parseWithPointers = <T = any>(
  value: string,
  options: IParseOptions = { disallowComments: true },
): JsonParserResult<T> => {
  const diagnostics: IDiagnostic[] = [];
  const { ast, data, lineMap } = parseTree<T>(value, diagnostics, options);

  return {
    data,
    diagnostics,
    ast,
    lineMap,
  };
};

// based on source code of "https://github.com/Microsoft/node-jsonc-parser
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export function parseTree<T>(
  text: string,
  errors: IDiagnostic[] = [],
  options: IParseOptions,
): IParserASTResult<T, IJsonASTNode, number[]> {
  const lineMap = computeLineMap(text);
  let currentParent: IJsonASTNode = { type: 'array', offset: -1, length: -1, children: [], parent: void 0 }; // artificial root
  let currentParsedProperty: string | null = null;
  let currentParsedParent: any = [];
  const currentObjectKeys: string[] = [''];
  const previousParsedParents: any[] = [];

  function ensurePropertyComplete(endOffset: number) {
    if (currentParent.type === 'property') {
      currentParent.length = endOffset - currentParent.offset;
      currentParent = currentParent.parent!;
    }
  }

  function calculateRange(startLine: number, startCharacter: number, length: number): IRange {
    return {
      start: {
        line: startLine,
        character: startCharacter,
      },
      end: {
        line: startLine,
        character: startCharacter + length,
      },
    };
  }

  function onValue(valueNode: IJsonASTNode): IJsonASTNode {
    currentParent.children!.push(valueNode);
    return valueNode;
  }

  function onParsedValue(value: any) {
    if (Array.isArray(currentParsedParent)) {
      (currentParsedParent as any[]).push(value);
    } else if (currentParsedProperty) {
      currentParsedParent[currentParsedProperty] = value;
    }
  }

  function onParsedComplexBegin(value: any) {
    onParsedValue(value);
    previousParsedParents.push(currentParsedParent);
    currentParsedParent = value;
    currentParsedProperty = null;
  }

  function onParsedComplexEnd() {
    currentParsedParent = previousParsedParents.pop();
  }

  const visitor: JSONVisitor = {
    onObjectBegin: (offset, length, startLine, startCharacter: number) => {
      currentParent = onValue({
        type: 'object',
        offset,
        length: -1,
        parent: currentParent,
        children: [],
        range: calculateRange(startLine, startCharacter, length),
      });

      if (options.ignoreDuplicateKeys === false) {
        currentObjectKeys.length = 0;
      }

      onParsedComplexBegin({});
    },
    onObjectProperty: (name: string, offset: number, length: number, startLine: number, startCharacter: number) => {
      currentParent = onValue({ type: 'property', offset, length: -1, parent: currentParent, children: [] });
      currentParent.children!.push({ type: 'string', value: name, offset, length, parent: currentParent });

      if (options.ignoreDuplicateKeys === false) {
        if (currentObjectKeys.length === 0 || !currentObjectKeys.includes(name)) {
          currentObjectKeys.push(name);
        } else {
          errors.push({
            range: calculateRange(startLine, startCharacter, length),
            message: 'DuplicateKey',
            severity: DiagnosticSeverity.Error,
            path: getJsonPath(currentParent),
            code: 20, // 17 is the lowest safe value, but decided to bump it
          });
        }
      }

      currentParsedProperty = name;
    },
    onObjectEnd: (offset: number, length, startLine, startCharacter) => {
      currentParent.length = offset + length - currentParent.offset;
      if (currentParent.range) {
        // @ts-ignore, read only ;P
        currentParent.range.end.line = startLine;
        // @ts-ignore, read only ;P
        currentParent.range.end.character = startCharacter + length;
      }
      currentParent = currentParent.parent!;
      ensurePropertyComplete(offset + length);

      onParsedComplexEnd();
    },
    onArrayBegin: (offset, length, startLine, startCharacter) => {
      currentParent = onValue({
        type: 'array',
        offset,
        length: -1,
        parent: currentParent,
        children: [],
        range: calculateRange(startLine, startCharacter, length),
      });

      onParsedComplexBegin([]);
    },
    onArrayEnd: (offset, length, startLine, startCharacter) => {
      currentParent.length = offset + length - currentParent.offset;
      if (currentParent.range) {
        // @ts-ignore, read only ;P
        currentParent.range.end.line = startLine;
        // @ts-ignore, read only ;P
        currentParent.range.end.character = startCharacter + length;
      }
      currentParent = currentParent.parent!;
      ensurePropertyComplete(offset + length);

      onParsedComplexEnd();
    },
    onLiteralValue: (value, offset, length, startLine, startCharacter) => {
      onValue({
        type: getLiteralNodeType(value),
        offset,
        length,
        parent: currentParent,
        value,
        range: calculateRange(startLine, startCharacter, length),
      });
      ensurePropertyComplete(offset + length);

      onParsedValue(value);
    },
    onSeparator: (sep: string, offset: number, length: number) => {
      if (currentParent.type === 'property') {
        if (sep === ':') {
          currentParent.colonOffset = offset;
        } else if (sep === ',') {
          ensurePropertyComplete(offset);
        }
      }
    },
    onError: (error: ParseErrorCode, offset, length, startLine, startCharacter) => {
      errors.push({
        range: calculateRange(startLine, startCharacter, length),
        message: printParseErrorCode(error),
        severity: DiagnosticSeverity.Error,
        code: error,
      });
    },
  };
  visit(text, visitor, options);

  const result = currentParent.children![0];
  if (result) {
    delete result.parent;
  }
  return {
    ast: result,
    data: currentParsedParent[0],
    lineMap,
  };
}

function getLiteralNodeType(value: any): NodeType {
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    default:
      return 'null';
  }
}

const computeLineMap = (input: string) => {
  const lineMap: number[] = [0];

  let i = 0;
  for (; i < input.length; i++) {
    if (input[i] === '\n') {
      lineMap.push(i + 1);
    }
  }

  lineMap.push(i + 1);

  return lineMap;
};

function getJsonPath(node: IJsonASTNode, path: JsonPath = []): JsonPath {
  if (node.type === 'property') {
    path.unshift(node.children![0].value);
  }

  if (node.parent !== void 0) {
    // RHS expr is to filter out root node (line 31)
    if (node.parent.type === 'array' && node.parent.parent !== void 0) {
      path.unshift(node.parent.children!.indexOf(node));
    }

    return getJsonPath(node.parent, path);
  }

  return path;
}
