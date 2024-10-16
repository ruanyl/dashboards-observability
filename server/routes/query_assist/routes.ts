/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApiResponse } from '@opensearch-project/opensearch';
import { schema } from '@osd/config-schema';
import { ObservabilityConfig } from '../..';
import {
  IOpenSearchDashboardsResponse,
  IRouter,
  ResponseError,
} from '../../../../../src/core/server';
import { ML_COMMONS_API_PREFIX, QUERY_ASSIST_API } from '../../../common/constants/query_assist';
import { generateFieldContext } from '../../common/helpers/query_assist/generate_field_context';

const AGENT_REQUEST_OPTIONS = {
  /**
   * It is time-consuming for LLM to generate final answer
   * Give it a large timeout window
   */
  requestTimeout: 5 * 60 * 1000,
  /**
   * Do not retry
   */
  maxRetries: 0,
};

type AgentResponse = ApiResponse<{
  inference_results: Array<{
    output: Array<{ name: string; result?: string }>;
  }>;
}>;

export function registerQueryAssistRoutes(router: IRouter, config: ObservabilityConfig) {
  const {
    ppl_agent_id: pplAgentId,
    response_summary_agent_id: responseSummaryAgentId,
    error_summary_agent_id: ErrorSummaryAgentId,
  } = config.query_assist;

  router.post(
    {
      path: QUERY_ASSIST_API.GENERATE_PPL,
      validate: {
        body: schema.object({
          index: schema.string(),
          question: schema.string(),
        }),
      },
    },
    async (
      context,
      request,
      response
    ): Promise<IOpenSearchDashboardsResponse<any | ResponseError>> => {
      if (!pplAgentId)
        return response.custom({
          statusCode: 400,
          body:
            'PPL agent not found in opensearch_dashboards.yml. Expected observability.query_assist.ppl_agent_id',
        });

      const client = context.core.opensearch.client.asCurrentUser;
      try {
        const pplRequest = (await client.transport.request(
          {
            method: 'POST',
            path: `${ML_COMMONS_API_PREFIX}/agents/${pplAgentId}/_execute`,
            body: {
              parameters: {
                index: request.body.index,
                question: request.body.question,
              },
            },
          },
          AGENT_REQUEST_OPTIONS
        )) as AgentResponse;
        if (!pplRequest.body.inference_results[0].output[0].result)
          throw new Error('Generated PPL query not found.');
        const result = JSON.parse(pplRequest.body.inference_results[0].output[0].result) as {
          ppl: string;
          executionResult: string;
        };
        const ppl = result.ppl
          .replace(/[\r\n]/g, ' ')
          .trim()
          .replace(/ISNOTNULL/g, 'isnotnull') // https://github.com/opensearch-project/sql/issues/2431
          .replace(/`/g, '') // https://github.com/opensearch-project/dashboards-observability/issues/509, https://github.com/opensearch-project/dashboards-observability/issues/557
          .replace(/\bSPAN\(/g, 'span('); // https://github.com/opensearch-project/dashboards-observability/issues/759
        return response.ok({ body: ppl });
      } catch (error) {
        return response.custom({
          statusCode: error.statusCode || 500,
          body: error.message,
        });
      }
    }
  );

  router.post(
    {
      path: QUERY_ASSIST_API.SUMMARIZE,
      validate: {
        body: schema.object({
          index: schema.string(),
          question: schema.string(),
          query: schema.maybe(schema.string()),
          response: schema.string(),
          isError: schema.boolean(),
        }),
      },
    },
    async (
      context,
      request,
      response
    ): Promise<IOpenSearchDashboardsResponse<any | ResponseError>> => {
      if (!responseSummaryAgentId || !ErrorSummaryAgentId)
        return response.custom({
          statusCode: 400,
          body:
            'Summary agent not found in opensearch_dashboards.yml. Expected observability.query_assist.response_summary_agent_id and observability.query_assist.error_summary_agent_id',
        });

      const client = context.core.opensearch.client.asCurrentUser;
      const { index, question, query, response: _response, isError } = request.body;
      const queryResponse = JSON.stringify(_response);
      let summaryRequest: AgentResponse;
      try {
        if (!isError) {
          summaryRequest = (await client.transport.request(
            {
              method: 'POST',
              path: `${ML_COMMONS_API_PREFIX}/agents/${responseSummaryAgentId}/_execute`,
              body: {
                parameters: { index, question, query, response: queryResponse },
              },
            },
            AGENT_REQUEST_OPTIONS
          )) as AgentResponse;
        } else {
          const [mappings, sampleDoc] = await Promise.all([
            client.indices.getMapping({ index }),
            client.search({ index, size: 1 }),
          ]);
          const fields = generateFieldContext(mappings, sampleDoc);
          summaryRequest = (await client.transport.request(
            {
              method: 'POST',
              path: `${ML_COMMONS_API_PREFIX}/agents/${ErrorSummaryAgentId}/_execute`,
              body: {
                parameters: { index, question, query, response: queryResponse, fields },
              },
            },
            AGENT_REQUEST_OPTIONS
          )) as AgentResponse;
        }
        const summary = summaryRequest.body.inference_results[0].output[0].result;
        if (!summary) throw new Error('Generated summary not found.');
        const suggestedQuestions = Array.from(
          (summaryRequest.body.inference_results[0].output[1]?.result || '').matchAll(
            /<question>((.|[\r\n])+?)<\/question>/g
          )
        ).map((m) => (m as unknown[])[1]);
        return response.ok({
          body: {
            summary,
            suggestedQuestions,
          },
        });
      } catch (error) {
        return response.custom({
          statusCode: error.statusCode || 500,
          body: error.message,
        });
      }
    }
  );
}
