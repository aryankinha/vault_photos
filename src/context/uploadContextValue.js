/**
 * Raw UploadContext object — kept in a plain .js file so the .jsx provider file
 * can satisfy react-refresh (only exports components) while the hook file can
 * also import from here without circular dependency.
 */
import { createContext } from 'react'

export const UploadContext = createContext(null)
