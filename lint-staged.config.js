export default {
  '*.{ts,tsx,js}': ['eslint --fix', 'prettier --write'],
  '*.{json,yml,yaml,css,html}': 'prettier --write',
}
