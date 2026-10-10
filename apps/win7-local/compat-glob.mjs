import glob from 'win7-fast-glob'
export const globSync = (pattern, options) => glob.sync(pattern, { ...options, onlyFiles: false, unique: true })
