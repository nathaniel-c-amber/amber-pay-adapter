// Public barrel: expose the contract, errors, and registry only. Concrete
// adaptor implementations (QuickBooks/Sage) stay internal so consumers depend
// on the `AccountingAdaptor` interface, not a specific implementation.
export * from '../../types/adaptor.js';
export * from './errors.js';
export * from './registry.js';
