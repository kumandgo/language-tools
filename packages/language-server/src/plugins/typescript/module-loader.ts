import ts from 'typescript';
import {
    isVirtualSvelteFilePath,
    ensureRealSvelteFilePath,
    getExtensionFromScriptKind
} from './utils';
import { DocumentSnapshot } from './DocumentSnapshot';
import { createSvelteSys } from './svelte-sys';

/**
 * Caches resolved modules.
 */
class ModuleResolutionCache {
    private cache = new Map<string, ts.ResolvedModule>();

    /**
     * Tries to get a cached module.
     */
    get(moduleName: string, containingFile: string): ts.ResolvedModule | undefined {
        return this.cache.get(this.getKey(moduleName, containingFile));
    }

    /**
     * Caches resolved module, if it is not undefined.
     */
    set(moduleName: string, containingFile: string, resolvedModule: ts.ResolvedModule | undefined) {
        if (!resolvedModule) {
            return;
        }
        this.cache.set(this.getKey(moduleName, containingFile), resolvedModule);
    }

    /**
     * Deletes module from cache. Call this if a file was deleted.
     * @param resolvedModuleName full path of the module
     */
    delete(resolvedModuleName: string): void {
        this.cache.forEach((val, key) => {
            if (val.resolvedFileName === resolvedModuleName) {
                this.cache.delete(key);
            }
        });
    }

    private getKey(moduleName: string, containingFile: string) {
        return containingFile + ':::' + ensureRealSvelteFilePath(moduleName);
    }
}

/**
 * Creates a module loader specifically for `.svelte` files.
 *
 * The typescript language service tries to look up other files that are referenced in the currently open svelte file.
 * For `.ts`/`.js` files this works, for `.svelte` files it does not by default.
 * Reason: The typescript language service does not know about the `.svelte` file ending,
 * so it assumes it's a normal typescript file and searches for files like `../Component.svelte.ts`, which is wrong.
 * In order to fix this, we need to wrap typescript's module resolution and reroute all `.svelte.ts` file lookups to .svelte.
 *
 * @param getSnapshot A function which returns a (in case of svelte file fully preprocessed) typescript/javascript snapshot
 * @param compilerOptions The typescript compiler options
 */
export function createSvelteModuleLoader(
    getSnapshot: (fileName: string) => DocumentSnapshot,
    compilerOptions: ts.CompilerOptions
) {
    const svelteSys = createSvelteSys(getSnapshot);
    const moduleCache = new ModuleResolutionCache();

    return {
        fileExists: svelteSys.fileExists,
        readFile: svelteSys.readFile,
        readDirectory: svelteSys.readDirectory,
        deleteFromModuleCache: (path: string) => moduleCache.delete(path),
        resolveModuleNames
    };

    function resolveModuleNames(
        moduleNames: string[],
        containingFile: string
    ): Array<ts.ResolvedModule | undefined> {
        return moduleNames.map((moduleName) => {
            const cachedModule = moduleCache.get(moduleName, containingFile);
            if (cachedModule) {
                return cachedModule;
            }

            const resolvedModule = resolveModuleName(moduleName, containingFile);
            moduleCache.set(moduleName, containingFile, resolvedModule);
            return resolvedModule;
        });
    }

    function resolveModuleName(
        name: string,
        containingFile: string
    ): ts.ResolvedModule | undefined {
        // Delegate to the TS resolver first.
        // If that does not bring up anything, try the Svelte Module loader
        // which is able to deal with .svelte files.
        const tsResolvedModule = ts.resolveModuleName(name, containingFile, compilerOptions, ts.sys)
            .resolvedModule;
        if (tsResolvedModule && !isVirtualSvelteFilePath(tsResolvedModule.resolvedFileName)) {
            return tsResolvedModule;
        }

        const svelteResolvedModule = ts.resolveModuleName(
            name,
            containingFile,
            compilerOptions,
            svelteSys
        ).resolvedModule;
        if (
            !svelteResolvedModule ||
            !isVirtualSvelteFilePath(svelteResolvedModule.resolvedFileName)
        ) {
            return svelteResolvedModule;
        }

        const resolvedFileName = ensureRealSvelteFilePath(svelteResolvedModule.resolvedFileName);
        const snapshot = getSnapshot(resolvedFileName);

        const resolvedSvelteModule: ts.ResolvedModuleFull = {
            extension: getExtensionFromScriptKind(snapshot && snapshot.scriptKind),
            resolvedFileName
        };
        return resolvedSvelteModule;
    }
}
