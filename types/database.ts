export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          plan_level: string;
          settings: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          plan_level?: string;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          plan_level?: string;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_profiles: {
        Row: {
          id: string;
          organization_id: string | null;
          name: string | null;
          avatar_url: string | null;
          role: string;
          plan_level: string;
          tags: string[];
          metadata: Json;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          organization_id?: string | null;
          name?: string | null;
          avatar_url?: string | null;
          role?: string;
          plan_level?: string;
          tags?: string[];
          metadata?: Json;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          name?: string | null;
          avatar_url?: string | null;
          role?: string;
          plan_level?: string;
          tags?: string[];
          metadata?: Json;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_profiles_id_fkey';
            columns: ['id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_profiles_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      ai_roles: {
        Row: {
          id: string;
          organization_id: string | null;
          name: string;
          description: string | null;
          icon: string | null;
          category: string;
          model: string;
          model_provider: string;
          temperature: number;
          max_tokens: number;
          current_prompt_version_id: string | null;
          knowledge_base_ids: string[];
          enable_rag: boolean;
          enabled_tools: string[];
          required_plan: string;
          required_tags: string[];
          is_active: boolean;
          sort_order: number;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          name: string;
          description?: string | null;
          icon?: string | null;
          category?: string;
          model: string;
          model_provider?: string;
          temperature?: number;
          max_tokens?: number;
          current_prompt_version_id?: string | null;
          knowledge_base_ids?: string[];
          enable_rag?: boolean;
          enabled_tools?: string[];
          required_plan?: string;
          required_tags?: string[];
          is_active?: boolean;
          sort_order?: number;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          name?: string;
          description?: string | null;
          icon?: string | null;
          category?: string;
          model?: string;
          model_provider?: string;
          temperature?: number;
          max_tokens?: number;
          current_prompt_version_id?: string | null;
          knowledge_base_ids?: string[];
          enable_rag?: boolean;
          enabled_tools?: string[];
          required_plan?: string;
          required_tags?: string[];
          is_active?: boolean;
          sort_order?: number;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ai_roles_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ai_roles_current_prompt_version_id_fkey';
            columns: ['current_prompt_version_id'];
            isOneToOne: false;
            referencedRelation: 'prompt_versions';
            referencedColumns: ['id'];
          },
        ];
      };
      prompt_versions: {
        Row: {
          id: string;
          role_id: string;
          version_number: number;
          system_prompt: string;
          change_note: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          role_id: string;
          version_number: number;
          system_prompt: string;
          change_note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          role_id?: string;
          version_number?: number;
          system_prompt?: string;
          change_note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'prompt_versions_role_id_fkey';
            columns: ['role_id'];
            isOneToOne: false;
            referencedRelation: 'ai_roles';
            referencedColumns: ['id'];
          },
        ];
      };
      conversations: {
        Row: {
          id: string;
          user_id: string;
          organization_id: string | null;
          role_id: string | null;
          prompt_version_id: string | null;
          title: string;
          folder_id: string | null;
          tags: string[];
          is_pinned: boolean;
          is_shared: boolean;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          organization_id?: string | null;
          role_id?: string | null;
          prompt_version_id?: string | null;
          title?: string;
          folder_id?: string | null;
          tags?: string[];
          is_pinned?: boolean;
          is_shared?: boolean;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          organization_id?: string | null;
          role_id?: string | null;
          prompt_version_id?: string | null;
          title?: string;
          folder_id?: string | null;
          tags?: string[];
          is_pinned?: boolean;
          is_shared?: boolean;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'conversations_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'conversations_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'conversations_role_id_fkey';
            columns: ['role_id'];
            isOneToOne: false;
            referencedRelation: 'ai_roles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'conversations_prompt_version_id_fkey';
            columns: ['prompt_version_id'];
            isOneToOne: false;
            referencedRelation: 'prompt_versions';
            referencedColumns: ['id'];
          },
        ];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          role: 'user' | 'assistant' | 'system' | 'tool';
          content: string;
          content_type: string;
          attachments: Json;
          tool_calls: Json;
          tool_results: Json;
          knowledge_refs: Json;
          model_used: string | null;
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cost_usd: number;
          duration_ms: number;
          user_rating: number | null;
          user_feedback: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          role: 'user' | 'assistant' | 'system' | 'tool';
          content: string;
          content_type?: string;
          attachments?: Json;
          tool_calls?: Json;
          tool_results?: Json;
          knowledge_refs?: Json;
          model_used?: string | null;
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost_usd?: number;
          duration_ms?: number;
          user_rating?: number | null;
          user_feedback?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          role?: 'user' | 'assistant' | 'system' | 'tool';
          content?: string;
          content_type?: string;
          attachments?: Json;
          tool_calls?: Json;
          tool_results?: Json;
          knowledge_refs?: Json;
          model_used?: string | null;
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost_usd?: number;
          duration_ms?: number;
          user_rating?: number | null;
          user_feedback?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
        ];
      };
      knowledge_bases: {
        Row: {
          id: string;
          organization_id: string | null;
          name: string;
          description: string | null;
          category: string | null;
          is_active: boolean;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          name: string;
          description?: string | null;
          category?: string | null;
          is_active?: boolean;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          name?: string;
          description?: string | null;
          category?: string | null;
          is_active?: boolean;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'knowledge_bases_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      knowledge_items: {
        Row: {
          id: string;
          knowledge_base_id: string;
          title: string | null;
          content: string;
          source_url: string | null;
          tags: string[];
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          knowledge_base_id: string;
          title?: string | null;
          content: string;
          source_url?: string | null;
          tags?: string[];
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          knowledge_base_id?: string;
          title?: string | null;
          content?: string;
          source_url?: string | null;
          tags?: string[];
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'knowledge_items_knowledge_base_id_fkey';
            columns: ['knowledge_base_id'];
            isOneToOne: false;
            referencedRelation: 'knowledge_bases';
            referencedColumns: ['id'];
          },
        ];
      };
      external_api_calls: {
        Row: {
          id: string;
          user_id: string | null;
          service_name: string;
          endpoint: string | null;
          request_payload: Json | null;
          response_payload: Json | null;
          status: string | null;
          cost_usd: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          service_name: string;
          endpoint?: string | null;
          request_payload?: Json | null;
          response_payload?: Json | null;
          status?: string | null;
          cost_usd?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          service_name?: string;
          endpoint?: string | null;
          request_payload?: Json | null;
          response_payload?: Json | null;
          status?: string | null;
          cost_usd?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'external_api_calls_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      scheduled_tasks: {
        Row: {
          id: string;
          organization_id: string | null;
          task_type: string;
          schedule_cron: string | null;
          config: Json;
          last_run_at: string | null;
          next_run_at: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          task_type: string;
          schedule_cron?: string | null;
          config?: Json;
          last_run_at?: string | null;
          next_run_at?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          task_type?: string;
          schedule_cron?: string | null;
          config?: Json;
          last_run_at?: string | null;
          next_run_at?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scheduled_tasks_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      audit_logs: {
        Row: {
          id: string;
          user_id: string | null;
          organization_id: string | null;
          action: string;
          resource_type: string | null;
          resource_id: string | null;
          details: Json;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          organization_id?: string | null;
          action: string;
          resource_type?: string | null;
          resource_id?: string | null;
          details?: Json;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          organization_id?: string | null;
          action?: string;
          resource_type?: string | null;
          resource_id?: string | null;
          details?: Json;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_logs_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'audit_logs_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      usage_stats_daily: {
        Row: {
          id: string;
          user_id: string | null;
          organization_id: string | null;
          date: string;
          message_count: number;
          conversation_count: number;
          total_tokens: number;
          total_cost_usd: number;
          models_used: Json;
          roles_used: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          organization_id?: string | null;
          date: string;
          message_count?: number;
          conversation_count?: number;
          total_tokens?: number;
          total_cost_usd?: number;
          models_used?: Json;
          roles_used?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          organization_id?: string | null;
          date?: string;
          message_count?: number;
          conversation_count?: number;
          total_tokens?: number;
          total_cost_usd?: number;
          models_used?: Json;
          roles_used?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'usage_stats_daily_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'usage_stats_daily_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      system_settings: {
        Row: {
          key: string;
          value: Json;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          key: string;
          value?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          key?: string;
          value?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
