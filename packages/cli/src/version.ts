/** The CLI version, from package.json (bundled into the compiled binary). */
import pkg from '../package.json'

export const CLI_VERSION: string = pkg.version
