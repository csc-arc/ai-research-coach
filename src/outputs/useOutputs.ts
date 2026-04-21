import { useState, useCallback, useRef } from 'react';
import { OutputItem, OutputEmitter } from './types';
import { getServerUrl, useLocalServer as setToLocalServer } from '../serverConfig';

/**
 * React hook for managing outputs in memory only (no persistence)
 */
export const useOutputs = () => {
  const [outputs, setOutputs] = useState<OutputItem[]>([]);
  
  // Store pending approval promises
  const approvalPromisesRef = useRef<Map<string, {
    resolve: (approved: boolean) => void;
    reject: (error: Error) => void;
  }>>(new Map());

  /**
   * Add a new output item
   */
  const addOutput = useCallback((output: Omit<OutputItem, 'id' | 'timestamp'>) => {
    const newOutput = {
      ...output,
      id: `output-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    } as OutputItem;

    setOutputs(prev => [...prev, newOutput]);
    return newOutput.id;
  }, []);

  /**
   * Delete a specific output item
   */
  const deleteOutput = useCallback((id: string) => {
    setOutputs(prev => prev.filter(output => output.id !== id));
  }, []);

  /**
   * Clear all outputs
   */
  const clearAll = useCallback(() => {
    setOutputs([]);
  }, []);

  /**
   * Request approval for a script execution
   */
  const requestApproval = useCallback((outputId: string): Promise<boolean> => {
    // Check for auto-approve query parameter
    const autoApprove = new URLSearchParams(window.location.search).get('auto-approve') === '1';
    
    if (autoApprove) {
      // Auto-approve and update output state immediately
      setOutputs(prev => prev.map(o => {
        if (o.id === outputId && (o.type === 'script')) {
          return { ...o, metadata: { ...o.metadata, pendingApproval: false, approved: true }};
        }
        return o;
      }));
      return Promise.resolve(true);
    }
    
    // Normal approval flow
    return new Promise((resolve, reject) => {
      approvalPromisesRef.current.set(outputId, { resolve, reject });
    });
  }, []);

  /**
   * Approve a script execution
   */
  const approveScript = useCallback((id: string) => {
    const promise = approvalPromisesRef.current.get(id);
    if (promise) {
      promise.resolve(true);
      approvalPromisesRef.current.delete(id);
    }
    // Update output state
    setOutputs(prev => prev.map(o => {
      if (o.id === id && (o.type === 'script')) {
        return { ...o, metadata: { ...o.metadata, pendingApproval: false, approved: true }};
      }
      return o;
    }));
  }, []);

  /**
   * Deny a script execution
   */
  const denyScript = useCallback((id: string) => {
    const promise = approvalPromisesRef.current.get(id);
    if (promise) {
      promise.resolve(false);
      approvalPromisesRef.current.delete(id);
    }
    // Update output state
    setOutputs(prev => prev.map(o => {
      if (o.id === id && (o.type === 'script')) {
        return { ...o, metadata: { ...o.metadata, pendingApproval: false, denied: true }};
      }
      return o;
    }));
  }, []);

  /**
   * Update server health check status for a script output
   */
  const updateServerHealth = useCallback((id: string, status: 'checking' | 'healthy' | 'unhealthy', error?: string) => {
    setOutputs(prev => prev.map(o => {
      if (o.id === id && (o.type === 'script')) {
        return {
          ...o,
          metadata: {
            ...o.metadata,
            serverHealthCheck: status,
            serverError: error,
          }
        };
      }
      return o;
    }));
  }, []);

  /**
   * Update execution status for a script output
   */
  const updateExecutionStatus = useCallback((id: string, status: 'running' | 'completed' | 'failed') => {
    setOutputs(prev => prev.map(o => {
      if (o.id === id && (o.type === 'script')) {
        return {
          ...o,
          metadata: {
            ...o.metadata,
            executionStatus: status,
          }
        };
      }
      return o;
    }));
  }, []);

  /**
   * Retry server health check and proceed to approval if healthy
   */
  const retryServerCheck = useCallback(async (id: string) => {
    // Set to checking state
    updateServerHealth(id, 'checking');
    
    try {
      const healthResponse = await fetch(`${getServerUrl()}/health`, {
        method: "GET",
      });

      if (!healthResponse.ok) {
        // Server responded but not healthy
        updateServerHealth(id, 'unhealthy', `Server responded with status ${healthResponse.status}`);
        return;
      }

      // Server is healthy, update the status
      updateServerHealth(id, 'healthy');
    } catch (error) {
      // Server is not running or unreachable
      updateServerHealth(id, 'unhealthy', error instanceof Error ? error.message : "Unknown error");
    }
  }, [updateServerHealth]);

  /**
   * Switch to using the local development server and retry health check.
   * (The remote droplet is the default; this lets developers fall back to localhost.)
   */
  const useFallbackServer = useCallback(async (id: string) => {
    setToLocalServer();

    updateServerHealth(id, 'checking');
    
    try {
      const healthResponse = await fetch(`${getServerUrl()}/health`, {
        method: "GET",
      });

      if (!healthResponse.ok) {
        // Server responded but not healthy
        updateServerHealth(id, 'unhealthy', `Server responded with status ${healthResponse.status}`);
        return;
      }

      // Server is healthy, update the status
      updateServerHealth(id, 'healthy');
    } catch (error) {
      // Server is not running or unreachable
      updateServerHealth(id, 'unhealthy', error instanceof Error ? error.message : "Unknown error");
    }
  }, [updateServerHealth]);

  /**
   * Create an output emitter function for use in tool execution context
   */
  const createEmitter = useCallback((): OutputEmitter => {
    return (output: Omit<OutputItem, 'id' | 'timestamp'>) => {
      return addOutput(output);
    };
  }, [addOutput]);

  return {
    outputs,
    loading: false,
    error: null,
    addOutput,
    deleteOutput,
    clearAll,
    createEmitter,
    requestApproval,
    approveScript,
    denyScript,
    updateServerHealth,
    updateExecutionStatus,
    retryServerCheck,
    useFallbackServer,
  };
};