/**
 * Azure Resource Graph collector — kept as the import path older code uses. The implementation (paging,
 * subscription batching, throttling, normalisation, fixtures) lives in ../azure/resourceGraph.ts.
 */
export { collectResourceGraph as collectAzure, normaliseResource, listSubscriptions, RG_API_VERSION } from "../azure/resourceGraph.js";
