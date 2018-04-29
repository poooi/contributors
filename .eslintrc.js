module.exports = {
  'extends': 'airbnb-base',
  'plugins': [
    'import'
  ],
  'parser': 'babel-eslint',
  'rules': {
    'comma-dangle': ['error', 'always-multiline'],
    'semi': ['error', 'never'],
    'import/no-extraneous-dependencies': ['error', { 'devDependencies': true }],
    'no-console': 'off',
    'object-curly-newline': 'off',
    'function-paren-newline': 'off',
  }
}
