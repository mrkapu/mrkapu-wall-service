import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RekognitionService } from '../common/rekognition.service';
import { S3Service } from '../common/s3.service';
import { TextModerationService } from '../common/text-moderation.service';
import {
  Circle,
  CirclePost,
  CirclePostSchema,
  CircleSchema,
} from '../circles/circle.entity';
import { SharedAuthModule } from '../shared/auth/shared-auth.module';
import { SharedAdvertisementPlacementModule } from '../shared/data-access/shared-advertisement-placement.module';
import { SharedUserAccountModule } from '../shared/data-access/shared-user-account.module';
import { SharedEventsModule } from '../shared/events/shared-events.module';
import {
  MembershipGuardService,
  UserRef,
  UserRefSchema,
} from '../shared/membership/membership-guard.service';
import { WallController } from './wall.controller';
import { WallPost, WallPostSchema } from './wall.entity';
import { WallService } from './wall.service';
import { WallViewEvent, WallViewEventSchema } from './wall-view-event.entity';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WallPost.name, schema: WallPostSchema },
      { name: WallViewEvent.name, schema: WallViewEventSchema },
      { name: Circle.name, schema: CircleSchema },
      { name: CirclePost.name, schema: CirclePostSchema },
      { name: UserRef.name, schema: UserRefSchema },
    ]),
    SharedUserAccountModule,
    SharedAdvertisementPlacementModule,
    SharedAuthModule,
    SharedEventsModule,
  ],
  controllers: [WallController],
  providers: [WallService, S3Service, RekognitionService, TextModerationService, MembershipGuardService],
  exports: [WallService],
})
export class WallModule {}
