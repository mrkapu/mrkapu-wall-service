import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Model } from 'mongoose';

@Schema({ collection: 'auth_users' })
export class UserRef {
  @Prop() account_type?: string;
  @Prop() personal_tier?: string;
  @Prop() personal_tier_expires_at?: Date;
  @Prop() service_tier?: string;
  @Prop() service_tier_expires_at?: Date;
}

export type UserRefDocument = HydratedDocument<UserRef>;
export const UserRefSchema = SchemaFactory.createForClass(UserRef);

export interface UserMembership {
  accountType: string;
  effectiveTier: string;
}

@Injectable()
export class MembershipGuardService {
  constructor(
    @InjectModel(UserRef.name) private readonly userRefModel: Model<UserRefDocument>,
  ) {}

  async getMembership(userId: string): Promise<UserMembership | null> {
    const user = await this.userRefModel
      .findById(userId)
      .select('account_type personal_tier personal_tier_expires_at service_tier service_tier_expires_at')
      .lean()
      .exec();

    if (!user) return null;

    const accountType = user.account_type || 'user';
    const isService = accountType === 'service_account';
    // Tiers live in separate fields per track — service_tier for vendors,
    // personal_tier for everyone else. There is no single shared
    // "membership_tier" field on the User doc (mrkapu-user-service never
    // writes one); reading per-track fields directly here, rather than a
    // field that's always empty, is the fix.
    const tier = isService ? user.service_tier : user.personal_tier;
    const expiresAt = isService ? user.service_tier_expires_at : user.personal_tier_expires_at;
    const defaultTier = isService ? 'default' : 'free';
    const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false;
    const effectiveTier = isExpired ? defaultTier : (tier || defaultTier);

    return { accountType, effectiveTier };
  }

  // Video is exclusive to vendor/service-provider accounts — no personal
  // tier (free/silver/premium) may post video, regardless of tier.
  async canPostVideo(userId: string): Promise<boolean> {
    const membership = await this.getMembership(userId);
    return membership?.accountType === 'service_account';
  }

  // Daily wall-post cap for personal accounts. null = unlimited.
  // free -> 0 (blocked entirely), silver -> 10/day, premium -> unlimited.
  // Service accounts (vendors) are unaffected by this cap.
  async getDailyPostLimit(userId: string): Promise<number | null> {
    const membership = await this.getMembership(userId);
    if (!membership || membership.accountType === 'service_account') return null;
    if (membership.effectiveTier === 'premium') return null;
    if (membership.effectiveTier === 'silver') return 10;
    return 0;
  }
}
