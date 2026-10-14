'use strict';
const ts = require('../vendor/typescript');

function valueContext(node) {
  const source = node.getSourceFile(), conditions = [];
  const condition = (expression, branch, kind) => {
    if (!expression) return;
    const start = source.getLineAndCharacterOfPosition(expression.getStart(source));
    const text = expression.getText(source);
    conditions.unshift({expression:text.slice(0,1000),truncated:text.length > 1000,branch,kind,line:start.line+1,column:start.character+1});
  };
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) break;
    if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement) condition(parent.expression, 'true', 'if');
      if (child === parent.elseStatement) condition(parent.expression, 'false', 'if');
    } else if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue) condition(parent.condition, 'true', 'ternary');
      if (child === parent.whenFalse) condition(parent.condition, 'false', 'ternary');
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      const op=parent.operatorToken.kind;
      const branch=op===ts.SyntaxKind.AmpersandAmpersandToken||op===ts.SyntaxKind.AmpersandAmpersandEqualsToken?'truthy':op===ts.SyntaxKind.BarBarToken||op===ts.SyntaxKind.BarBarEqualsToken?'falsy':op===ts.SyntaxKind.QuestionQuestionToken||op===ts.SyntaxKind.QuestionQuestionEqualsToken?'nullish':undefined;
      if (branch) condition(parent.left, branch, 'short-circuit');
    } else if (ts.isWhileStatement(parent) && child === parent.statement) condition(parent.expression, 'true', 'while');
    else if (ts.isForStatement(parent) && child === parent.statement) condition(parent.condition, 'true', 'for');
    else if (ts.isDoStatement(parent) && child === parent.statement) condition(parent.expression, 'checked after the body', 'do');
    else if (ts.isCaseClause(parent)) condition(parent.expression, 'matches '+parent.parent.parent.expression.getText(source), 'switch case');
    else if (ts.isDefaultClause(parent)) conditions.unshift({expression:'No case matches the switch value',branch:'default',kind:'switch default'});
  }
  let expression = node;
  if (ts.isIdentifier(node) && ts.isVariableDeclaration(node.parent) && node.parent.name === node) expression = node.parent;
  if (ts.isVariableDeclaration(expression)) expression = expression.initializer;
  else if (ts.isReturnStatement(expression) || ts.isExpressionStatement(expression)) expression = expression.expression;
  while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression))) expression = expression.expression;
  let transformation;
  if (expression && (ts.isBinaryExpression(expression) || ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression) || ts.isCallExpression(expression) || ts.isNewExpression(expression) || ts.isConditionalExpression(expression) || ts.isAwaitExpression(expression))) {
    const text = expression.getText(source);
    const operator = ts.isBinaryExpression(expression) ? expression.operatorToken.getText(source) : ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression) ? ts.tokenToString(expression.operator) : undefined;
    transformation = {expression:text.slice(0,1000),truncated:text.length > 1000,kind:ts.SyntaxKind[expression.kind],...(operator ? {operator} : {})};
  }
  return {...(transformation ? {transformation} : {}),...(conditions.length ? {conditions} : {})};
}

module.exports = { valueContext };
