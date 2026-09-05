// A DrizzleQueryError carries the driver's SQLSTATE on its cause, not its own
// code. Keep direct SQLSTATE reads inside the shared cause-chain helpers.
function unwrap(node) {
  while (node && ['ChainExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(node.type)) {
    node = node.expression;
  }
  return node;
}

function isCode(node) {
  node = unwrap(node);
  return node?.type === 'MemberExpression'
    && (node.computed ? node.property.type === 'Literal' && node.property.value === 'code'
      : node.property.name === 'code');
}

function isSqlstate(node) {
  node = unwrap(node);
  return node?.type === 'Literal' && typeof node.value === 'string'
    // PostgreSQL standard classes plus FDW, PL/pgSQL and internal-error classes.
    // OS codes such as EPIPE are deliberately excluded.
    && /^(?:[0-9]{2}|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(node.value);
}

export const noDirectSqlstate = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { wrapped: 'Use pgErrorCode/isPgUniqueViolation from @breeze/shared/pgErrors; Drizzle wraps SQLSTATE in .cause.' },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        if ((isCode(node.left) && isSqlstate(node.right)) || (isSqlstate(node.left) && isCode(node.right))) {
          context.report({ node, messageId: 'wrapped' });
        }
      },
    };
  },
};

export default {
  plugins: { breeze: { rules: { 'no-direct-sqlstate': noDirectSqlstate } } },
  rules: { 'breeze/no-direct-sqlstate': 'error' },
};
